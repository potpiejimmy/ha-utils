import express from 'express';
import bodyParser from 'body-parser';
import nocache from 'nocache';
import { readFile, stat } from 'fs/promises';

const port = process.env.PORT || 3000;
const klassenarbeiten = process.env.HA_FILE_KLASSENARBEITEN || './samples/schulportal-result.json';
const vertretungen = process.env.HA_FILE_VERTRETUNGEN || './samples/dsb-result.json';
const faecher = process.env.HA_FILE_FAECHER || './samples/faecher.json';
const lehrer = process.env.HA_FILE_LEHRER || './samples/lehrer.json';
const alert = process.env.HA_FILE_ALERT || './samples/current_alert.md';

const app = express();

// add CORS headers
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Origin", req.headers.origin);
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    next();
});

app.use(bodyParser.json());
app.use(nocache());

app.get('/', (req, res) => {
  res.send('HA Utils up and running.');
});

app.get("/api/klassenarbeiten", async (req, res) => {
  res.send(markdownOrJson(req, await formatKlassenarbeiten()));
});

app.get("/api/alert", async (req, res) => {
  res.send(await formatAlert());
});

app.get("/api/vertretungen", async (req, res) => {
  const klassen = req.query.klassen ? req.query.klassen.split(',').map(k => k.trim()) : [];
  res.send(await formatVertretungen(klassen));
});

app.listen(port, () => {
  console.log(`HA Utils listening on port ${port}`);
});

function markdownOrJson(req, data) {
    if (req.query.md) return data.markdown.replace(/\n/g, "<br/>");
    return data;
}

function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function formatKlassenarbeiten() {
    const raw = await readFile(klassenarbeiten, 'utf-8');
    const data = JSON.parse(raw);

    const lines = [];
    let currentKW = null;
    let kwCount = 0;
    for (const termin of data.termine) {
        const emoji = termin.art === 'Klausuren' ? '\uD83D\uDCDD' : '\u2139\uFE0F';
        const date = new Date(termin.datumISO);
        const kw = getISOWeek(date);
        if (kw !== currentKW) {
            if (kwCount >= 3) break;
            if (currentKW !== null) lines.push('');
            lines.push(`_KW ${kw}_`);
            currentKW = kw;
            kwCount++;
        }
        const formattedDate = date.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'Europe/Berlin' });
        const text = termin.text.replace(/\b5c\b/g, 'Julian').replace(/\b8c\b/g, 'Enya').replace(/Arbeit/g, '').trim();
        lines.push(`${emoji} **${text}** - ${formattedDate}`);
    }

    const timestamp = new Date(data.timestamp).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
    });

    return {
        markdown: lines.join('\n'),
        lastUpdate: timestamp
    };
}

async function formatAlert() {
    const fileStat = await stat(alert);
    const mtime = fileStat.mtime;
    const ageMs = Date.now() - mtime.getTime();
    const markdown = ageMs > 24 * 60 * 60 * 1000 ? '' : await readFile(alert, 'utf-8');

    const timestamp = mtime.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Berlin',
    });

    return {
        markdown,
        lastUpdate: timestamp
    };
}

async function formatVertretungen(klassen) {
    const [rawDsb, rawLehrerFile, rawFaecherFile] = await Promise.all([
        readFile(vertretungen, 'utf-8'),
        readFile(lehrer, 'utf-8'),
        readFile(faecher, 'utf-8'),
    ]);
    const data = JSON.parse(rawDsb);
    const lehrerMap = JSON.parse(rawLehrerFile);
    const faecherMap = JSON.parse(rawFaecherFile);

    const resolveLehrer = (s) =>
        s.split('\u2192').map(part =>
            part.split(', ').map(a => { const n = lehrerMap[a.trim()] || a.trim(); return n.split(' ').pop(); }).join(', ')
        ).join(' \u2192 ');

    const resolveFach = (s) =>
        s.split('\u2192').map(a => faecherMap[a.trim()] || a.trim()).join(' \u2192 ');

    const result = {};

    for (const klasse of klassen) {
        const relevant = data.relevanteEintraege.filter(e => e.klasse === klasse);

        // Group by datum, preserving insertion order
        const byDatum = {};
        for (const e of relevant) {
            if (!byDatum[e.datum]) byDatum[e.datum] = [];
            byDatum[e.datum].push(e);
        }

        const lines = [];
        if (relevant.length === 0) {
            lines.push('_Keine Einträge_');
        }
        for (const datum of Object.keys(byDatum)) {
            const [d, m, y] = datum.split('.');
            const date = new Date(Number(y), Number(m) - 1, Number(d));
            const weekday = date.toLocaleDateString('de-DE', { weekday: 'long', timeZone: 'Europe/Berlin' });
            const formattedDate = date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' });
            lines.push(`||**${weekday}**|**${formattedDate}**||||`);
            lines.push('|-|-|-|-|-|-|');

            // Aggregate consecutive entries that differ only in "stunde"
            const groups = [];
            for (const e of byDatum[datum]) {
                const key = `${e.klasse}|${e.fach}|${e.raum}|${e.text}|${e.entfall}|${e.lehrer}`;
                const last = groups[groups.length - 1];
                if (last && last.key === key) {
                    last.stunden.push(e.stunde);
                } else {
                    groups.push({ key, entry: e, stunden: [e.stunde] });
                }
            }

            for (const { entry: e, stunden } of groups) {
                const emoji = e.entfall === 'x' ? '\u274C' : '\uD83D\uDD04';
                const nums = [...new Set(
                    stunden.flatMap(s => s ? s.split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n)) : [])
                )].sort((a, b) => a - b);
                const stunde = nums.length >= 2
                    ? `${nums[0]}.-${nums[nums.length - 1]}. Std.`
                    : nums.length === 1 ? `${nums[0]}. Std.` : '';
                const fach = e.fach ? resolveFach(e.fach) : '';
                const lehr = e.lehrer ? resolveLehrer(e.lehrer) : '';
                const raum = (e.raum || '').replace(/\u2192/g, ' \u2192 ');
                lines.push(`|${emoji}|${stunde}|${fach}|${lehr}|${raum}|${e.text || ''}|`);
            }
            lines.push('');
        }

        result[klasse] = { markdown: lines.join('\n') };
    }

    result.lastUpdate = data.lastUpdate;
    return result;
}
