// Pulls open roles from public ATS job-board APIs and writes jobs.json.
// Run: node scripts/fetch.mjs   (Node 20+, no dependencies)


// To remove Design Engineer roles add const TITLE_NOT = /graphic|industrial|mechanical|hardware|electrical|fashion|interior|level design|sound design|engineer|junior|associate|intern\b|internship|entry/i;
import { readFile, writeFile } from 'node:fs/promises';

/* ---------- Edit these to change what shows up ---------- */
const MAX_AGE_DAYS = 180; // drop roles posted longer ago than this
const TITLE_MUST = /(product|ux|ui|user experience|interaction|visual|brand|motion|creative|experience|service|content|communication|web)\s+design(er)?\b|design systems?|design ops|designops|^(senior |staff |principal |lead )*designer\b|\b(head|director|vp|vice president|manager|lead)\b.*\bdesign\b|\bdesign\b.*\b(director|manager|head)\b/i;
const TITLE_NOT = /graphic|industrial|mechanical|hardware|electrical|fashion|interior|level design|sound design|(?<!design systems? )engineer|pcb|layout|tooling|instructional|learning and development|junior|associate|intern\b|internship|entry/i;
const LA = /los angeles|santa monica|culver city|playa vista|el segundo|burbank|pasadena|glendale|hollywood|long beach|irvine|orange county|costa mesa|newport beach|torrance|hawthorne|manhattan beach|marina del rey|sherman oaks|woodland hills|southern california|socal/i;
const US = /united states|\bUSA?\b|\bU\.S\.|north america|americas/i;
const NOT_US = /canada|\bUK\b|united kingdom|london|europe|emea|apac|india|germany|berlin|france|paris|ireland|dublin|australia|singapore|japan|tokyo|brazil|mexico|israel|poland|spain|netherlands|latam|latin america|toronto|vancouver/i;
/* -------------------------------------------------------- */

const inLA = l => LA.test(l) || /\bLA\b/.test(l);
const keep = (l, w) => inLA(l) || !l.trim() || (w === 'Remote' && (US.test(l) || !NOT_US.test(l))) || /^\s*(US\s*-\s*)?(United States|USA?)\s*$/i.test(l);
const wp = s => (/remote/i.test(s || '') ? 'Remote' : /hybrid/i.test(s || '') ? 'Hybrid' : 'On-site');
const kind = s => (/part/i.test(s || '') ? 'Part-time' : /contract|temp/i.test(s || '') ? 'Contract' : /intern/i.test(s || '') ? 'Intern' : 'Full-time');
const discipline = t =>
  /\b(head|director|vp|vice president|manager)\b/i.test(t) ? 'Leadership' :
  /design system|design ops|designops/i.test(t) ? 'Design systems' :
  /research/i.test(t) ? 'Research' :
  /brand|visual|marketing|motion|creative|communication/i.test(t) ? 'Brand & visual' :
  /product|ux|\bui\b|interaction|experience|service|platform/i.test(t) ? 'Product & UX' : 'Other';

const get = async url => {
  const r = await fetch(url, { headers: { 'user-agent': 'jobs-board/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

// Each source returns rows shaped { title, url, location, posted, workplace, type, salary }
const sources = {
  greenhouse: async slug => {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return d.jobs.map(j => ({
      title: j.title, url: j.absolute_url, location: j.location?.name || '',
      posted: j.first_published || j.updated_at, workplace: wp(j.location?.name), type: 'Full-time', salary: ''
    }));
  },
  lever: async slug => {
    const d = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!Array.isArray(d)) throw new Error('Not a Lever board');
    return d.map(j => ({
      title: j.text, url: j.hostedUrl, location: (j.categories?.allLocations || [j.categories?.location]).filter(Boolean).join('; '),
      posted: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      workplace: wp(j.workplaceType || j.categories?.location), type: kind(j.categories?.commitment), salary: ''
    }));
  },
  ashby: async slug => {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    return d.jobs.filter(j => j.isListed !== false).map(j => ({
      title: j.title, url: j.jobUrl || j.applyUrl,
      location: [j.location, ...(j.secondaryLocations || []).map(l => l.location)].filter(Boolean).join('; '),
      posted: j.publishedAt, workplace: j.isRemote ? 'Remote' : wp(j.workplaceType), type: kind(j.employmentType),
      salary: j.compensation?.compensationTierSummary || ''
    }));
  }
};
sources.workable = async slug => {
  const d = await get(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
  return (d.jobs || []).map(j => ({
    title: j.title, url: j.url || j.application_url,
    location: [j.city, j.state, j.country].filter(Boolean).join(', '),
    posted: j.published_on || j.created_at, workplace: j.telecommuting ? 'Remote' : 'On-site',
    type: kind(j.employment_type), salary: ''
  }));
};
const companies = JSON.parse(await readFile('companies.json', 'utf8'));
let prev = {}, hadPrev = false;
try {
  const p = JSON.parse(await readFile('jobs.json', 'utf8'));
  hadPrev = p.jobs.length > 0;
  for (const j of p.jobs) prev[j.url] = j;
} catch {}

const today = new Date().toISOString().slice(0, 10);
const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
const found = new Map(), report = [];

async function run(c) {
  const order = c.ats ? [c.ats] : Object.keys(sources); // no "ats" set: try each until one answers
  let err;
  for (const ats of order) {
    try {
      const rows = await sources[ats](c.slug);
            const entry = { company: c.name, ats, open: rows.length, design: 0, kept: 0 };
      report.push(entry);
      for (const r of rows) {
        if (!r.url || !TITLE_MUST.test(r.title) || TITLE_NOT.test(r.title)) continue;
        if (r.posted && new Date(r.posted).getTime() < cutoff) continue;
                entry.design++;
        const fit = keep(r.location, r.workplace);
        if (fit) entry.kept++;
        else if (NOT_US.test(r.location) && !US.test(r.location)) continue;
        const posted = r.posted ? String(r.posted).slice(0, 10) : '';
        found.set(r.url, {
          title: r.title, company: c.name, url: r.url, location: r.location, discipline: discipline(r.title),
          fit,
          type: r.type, workplace: r.workplace, salary: r.salary, posted,
          firstSeen: prev[r.url]?.firstSeen || (hadPrev ? today : posted || today)
        });
      }
      return;
    } catch (e) { err = e; }
  }
  report.push({ company: c.name, error: String(err?.message || err) });
}

const queue = [...companies];
await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) await run(queue.shift()); }));

if (report.every(r => r.error)) { console.error('Every company failed; leaving jobs.json untouched.'); process.exit(1); }

const date = j => j.posted || j.firstSeen;
const jobs = [...found.values()].sort((a, b) => date(b).localeCompare(date(a)) || a.company.localeCompare(b.company));
report.sort((a, b) => a.company.localeCompare(b.company));
await writeFile('jobs.json', JSON.stringify({ updated: new Date().toISOString(), jobs, report }, null, 1));

for (const r of report) console.log(r.error ? `FAIL  ${r.company}: ${r.error}` : `ok    ${r.company} (${r.ats}, ${r.open} open, ${r.design} design, ${r.kept} kept)`);
console.log(`\n${jobs.length} matching roles from ${report.filter(r => !r.error).length}/${report.length} companies`);
