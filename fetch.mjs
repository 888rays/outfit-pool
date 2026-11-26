// Outfit pool fetcher v2: finds the BEST emo/goth looks on Roblox's avatars page.
// Every run searches ~200 themed queries (results change hourly), keeps every look whose name
// matches the theme in candidates.json, scores it by how many favorites its items have, tags it
// male/female, and rebuilds pool.json from the best ones. taste.json holds your sifting rules.
// Needs the ROBLOX_COOKIE secret (spare account). No installs needed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const COOKIE = process.env.ROBLOX_COOKIE;
const PER_GENDER = Math.max(50, Number(process.env.PER_GENDER) || 1000);
const MAX_PER_CREATOR = Math.max(1, Number(process.env.MAX_PER_CREATOR) || 5);
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 50);

const WIDGETS = 'https://apis.roblox.com/marketplace-widgets/v1/widgets';
const DETAILS = 'https://catalog.roblox.com/v1/catalog/items/details';
const SEARCH_DELAY_MS = 1300; // search limit is 60/minute
const HYDRATE_BATCH = 25;
const DETAILS_BATCH = 100;
const REFRESH_DAYS = 14; // re-check item favorites this often
const REFRESH_LIMIT = 3000; // max stale items re-checked per run

// ---------- theme, gender and scoring (pure, tested offline) ----------

export const THEMES = ['emo', 'goth', 'gothic', 'vkei', 'moe', 'alt', 'alternative'];
const MODIFIERS = [
	'', 'boy', 'guy', 'male', 'man', 'eboy', 'boy y2k', 'boy cheap', 'boy anime', 'boy black', 'boy dashie', 'boy grunge',
	'girl', 'girl y2k', 'girl cheap', 'girl anime', 'y2k', 'cheap', 'black', 'dark', 'dashie', 'grunge', 'punk', 'scene',
	'aesthetic', 'outfit', 'streetwear',
];
const MIXES = ['emo goth', 'vkei emo', 'moe emo', 'moe vkei', 'alt goth', 'alt emo', 'goth punk'];
export const QUERIES = [...new Set([
	...THEMES.flatMap((theme) => MODIFIERS.map((mod) => `${theme} ${mod}`.trim())),
	...MIXES.flatMap((mix) => [mix, `${mix} boy`, `${mix} girl`]),
])];

const MALE = ['boy', 'boys', 'guy', 'guys', 'man', 'men', 'male', 'dude', 'bro', 'eboy', 'e boy', 'femboy', 'handsome', 'king',
	'prince', 'masc', 'masculine', 'boyfriend', 'menino', 'garoto', 'chico', 'hombre', 'garcon', 'homme', 'ragazzo', 'junge'];
const FEMALE = ['girl', 'girls', 'gurl', 'girly', 'female', 'woman', 'women', 'lady', 'ladies', 'egirl', 'e girl', 'queen',
	'princess', 'femme', 'girlfriend', 'demoness', 'empress', 'goddess', 'gyaru', 'menina', 'garota', 'chica', 'mujer', 'fille',
	'ragazza', 'madchen', 'skirt', 'dress', 'pigtail', 'pigtails', 'twintails', 'ponytail'];

// "Vkei Emo Boy ♡" -> " vkei emo boy " (accents/emoji/punctuation stripped) so whole words can be matched
export const norm = (text) => ` ${String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
	.replace(/v[\s-]?kei|visual kei/g, 'vkei').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const hasWord = (normed, words) => words.some((word) => normed.includes(` ${word} `));
const count = (normed, words) => words.reduce((n, word) => n + (normed.includes(` ${word} `) ? 1 : 0), 0);

export const onTheme = (name) => hasWord(norm(name), THEMES);

// Only clothing and accessories count toward popularity (not bodies, heads or animations)
export const isStyleItem = (type) => /Accessory$|^(Hat|Shirt|Pants|TShirt)$/.test(type || '');

export function genderOf(cand, items) {
	let score = (count(norm(cand.n), MALE) - count(norm(cand.n), FEMALE)) * 3;
	for (const [id, type] of cand.a) {
		const name = norm(items[`a${id}`]?.[1]);
		score += count(name, MALE) - count(name, FEMALE);
		if (type === 'DressSkirtAccessory') score -= 1;
	}
	for (const id of cand.b) {
		const name = norm(items[`b${id}`]?.[1]);
		score += count(name, MALE) - count(name, FEMALE);
	}
	return score > 0 ? 'M' : score < 0 ? 'F' : 'U';
}

export function scoreOf(cand, items) {
	const favs = cand.a.filter(([, type]) => isStyleItem(type)).map(([id]) => items[`a${id}`]?.[0]).filter((f) => f != null);
	if (favs.length === 0) return 0;
	favs.sort((x, y) => x - y);
	const mid = favs.length >> 1;
	return favs.length % 2 ? favs[mid] : Math.round((favs[mid - 1] + favs[mid]) / 2);
}

export function buildPool(cands, items, taste) {
	const blockWords = (taste.blockWords || []).map((w) => norm(w).trim());
	const blockCreators = new Set((taste.blockCreators || []).map((c) => c.toLowerCase()));
	const liked = new Set((taste.likedCreators || []).map((c) => c.toLowerCase()));
	const rejected = new Set((taste.rejected || []).map(Number));
	const approved = new Set((taste.approved || []).map(Number));

	const rows = [];
	for (const [lookId, cand] of Object.entries(cands)) {
		const isApproved = approved.has(cand.o);
		const creator = cand.c.toLowerCase();
		if (!isApproved && (rejected.has(cand.o) || blockCreators.has(creator) || hasWord(norm(cand.n), blockWords))) continue;
		let score = scoreOf(cand, items);
		if (liked.has(creator)) score = Math.round(score * 1.5);
		if (!isApproved && score < MIN_SCORE) continue;
		rows.push({ lookId, cand, score, gender: genderOf(cand, items), approved: isApproved });
	}
	rows.sort((x, y) => (y.approved - x.approved) || (y.score - x.score));

	// Approved outfits always go in (unsure-gender ones as "U"); the rest fill up to PER_GENDER each,
	// skipping duplicates and capping each creator so one person's 20 recolors can't flood the pool.
	const picked = { M: [], F: [], U: [] };
	const perCreator = {};
	const seenKeys = new Set();
	for (const row of rows) {
		const { cand } = row;
		const key = cand.a.map(([id]) => id).sort((x, y) => x - y).join(',');
		const nameKey = `${cand.c}|${norm(cand.n)}`;
		const creator = cand.c.toLowerCase();
		if (seenKeys.has(cand.o)) continue;
		if (!row.approved) {
			if (row.gender === 'U' || picked[row.gender].length >= PER_GENDER) continue;
			if (seenKeys.has(key) || seenKeys.has(nameKey) || (perCreator[creator] || 0) >= MAX_PER_CREATOR) continue;
		}
		seenKeys.add(cand.o);
		seenKeys.add(key);
		seenKeys.add(nameKey);
		perCreator[creator] = (perCreator[creator] || 0) + 1;
		picked[row.gender].push({
			outfitId: cand.o,
			lookId: row.lookId,
			name: cand.n,
			curator: cand.c,
			gender: row.gender,
			score: row.score,
			...(row.approved ? { approved: true } : {}),
			assets: cand.a.map(([id, type, order]) => ({ id, type, order })),
			bundles: cand.b,
		});
	}
	return picked;
}

// ---------- Roblox requests ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let csrfToken = '';
class FatalError extends Error {}

// One request with Roblox's CSRF handshake; retries throttling/server errors. The cookie is never printed.
async function request(url, options = {}, attempt = 1) {
	const headers = {
		Cookie: `.ROBLOSECURITY=${COOKIE}`,
		Accept: 'application/json',
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
		...(options.body ? { 'Content-Type': 'application/json' } : {}),
		...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
	};
	let response;
	try {
		response = await fetch(url, { ...options, headers });
	} catch (error) {
		if (attempt <= 3) return sleep(3000 * attempt).then(() => request(url, options, attempt + 1));
		throw error;
	}
	const token = response.headers.get('x-csrf-token');
	if (response.status === 403 && token && token !== csrfToken && attempt <= 3) {
		csrfToken = token;
		return request(url, options, attempt + 1);
	}
	if (response.status === 401) {
		throw new FatalError('The login cookie expired or is invalid (401). Get a fresh cookie from the spare account and update ROBLOX_COOKIE.');
	}
	if ((response.status === 429 || response.status >= 500) && attempt <= 4) {
		return sleep((response.status === 429 ? 20000 : 4000) * attempt).then(() => request(url, options, attempt + 1));
	}
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} from ${url.split('?')[0]}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

async function searchLooks(query) {
	const data = await request(`${WIDGETS}?query=${encodeURIComponent(query)}&context=avatarTab`);
	const ids = [];
	for (const widget of Object.values(data.widgets || {})) {
		for (const item of widget?.content || []) if (item?.type === 'Look' && item.id) ids.push(String(item.id));
	}
	return ids;
}

const hydrate = (lookIds) => request(`${WIDGETS}/hydrate`, {
	method: 'POST',
	body: JSON.stringify({ Content: lookIds.map((id) => ({ id, type: 'Look' })) }),
}).then((data) => data.hydratedContent || []);

// Item details (favorites + names) for "a123"/"b456" keys. Splits a batch if Roblox rejects it.
async function details(keys, items, today) {
	try {
		const data = await request(DETAILS, {
			method: 'POST',
			body: JSON.stringify({ items: keys.map((key) => ({ itemType: key[0] === 'a' ? 'Asset' : 'Bundle', id: Number(key.slice(1)) })) }),
		});
		for (const key of keys) items[key] = [0, '', today]; // missing from the reply = deleted item
		for (const item of data.data || []) {
			const key = `${item.itemType === 'Bundle' ? 'b' : 'a'}${item.id}`;
			items[key] = [Number(item.favoriteCount) || 0, String(item.name || '').slice(0, 60), today];
		}
		return data.data?.[0];
	} catch (error) {
		if (error instanceof FatalError || keys.length === 1) throw error;
		const half = keys.length >> 1;
		await details(keys.slice(0, half), items, today);
		return details(keys.slice(half), items, today);
	}
}

const toCandidate = (look, today) => ({
	o: Number(look.outfitId),
	n: String(look.name || '').slice(0, 80),
	c: String(look.curator?.name || ''),
	a: (look.assets || []).filter((a) => Number(a.id)).map((a) => [Number(a.id), a.assetType ?? null, a.order ?? null]),
	b: (look.bundles || []).map((b) => Number(b.id)).filter(Boolean),
	f: today,
});

// ---------- run ----------

const load = (file, fallback) => readFile(file, 'utf8').then(JSON.parse).catch(() => fallback);

export async function main() {
	if (!COOKIE) throw new FatalError('The ROBLOX_COOKIE secret is missing. Add it in Settings > Secrets and variables > Actions.');
	const today = Math.floor(Date.now() / 86400000);
	const taste = await load('taste.json', {});
	const items = await load('items.json', {});
	const seen = new Set(await load('seen.json', []));
	let cands = await load('candidates.json', null);
	const status = { lastRun: new Date().toISOString(), searches: QUERIES.length, searchesOk: 0, newLooks: 0, newCandidates: 0, itemsChecked: 0, warnings: [] };
	const debug = {};

	// First v2 run: keep the on-theme outfits the old fetcher already found
	if (!cands) {
		cands = {};
		for (const o of (await load('pool.json', {})).outfits || []) {
			if (!o.lookId || !o.outfitId || !Array.isArray(o.assets)) continue;
			seen.add(o.lookId);
			if (onTheme(o.name)) cands[o.lookId] = { o: o.outfitId, n: o.name, c: o.curator || '', a: o.assets.map((a) => [a.id, a.type, a.order]), b: o.bundles || [], f: today };
		}
	}

	const save = async () => {
		const pool = buildPool(cands, items, taste);
		const outfits = [...pool.M, ...pool.F, ...pool.U];
		const genders = { M: 0, F: 0, U: 0 };
		for (const cand of Object.values(cands)) genders[genderOf(cand, items)]++;
		Object.assign(status, { candidates: Object.keys(cands).length, candidatesByGender: genders, pool: { total: outfits.length, male: pool.M.length, female: pool.F.length, unsure: pool.U.length } });
		await writeFile('candidates.json', JSON.stringify(cands));
		await writeFile('items.json', JSON.stringify(items));
		await writeFile('seen.json', JSON.stringify([...seen]));
		await writeFile('pool.json', JSON.stringify({ updated: status.lastRun, count: outfits.length, male: pool.M.length, female: pool.F.length, unsure: pool.U.length, outfits }));
		await writeFile('status.json', JSON.stringify(status, null, 2));
		await mkdir('debug', { recursive: true });
		for (const [name, value] of Object.entries(debug)) await writeFile(`debug/${name}.json`, JSON.stringify(value, null, 2).slice(0, 20000));
	};

	try {
		// 1) Search
		const pending = new Set();
		for (const query of QUERIES) {
			try {
				let fresh = 0;
				for (const id of await searchLooks(query)) if (!seen.has(id) && !pending.has(id)) { pending.add(id); fresh++; }
				status.searchesOk++;
				console.log(`"${query}": ${fresh} new`);
			} catch (error) {
				if (error instanceof FatalError) throw error;
				status.warnings.push(`search "${query}": ${error.message}`.slice(0, 200));
			}
			await sleep(SEARCH_DELAY_MS);
		}
		if (status.searchesOk === 0) throw new FatalError('Every search failed. Roblox may have changed the avatars page API. Nothing was changed.');
		status.newLooks = pending.size;

		// 2) Hydrate new looks; keep the on-theme ones
		const ids = [...pending];
		for (let i = 0; i < ids.length; i += HYDRATE_BATCH) {
			const batch = ids.slice(i, i + HYDRATE_BATCH);
			try {
				for (const look of await hydrate(batch)) {
					debug['sample-look'] ??= look;
					if (Number(look.outfitId) && onTheme(look.name)) {
						cands[String(look.id)] = toCandidate(look, today);
						status.newCandidates++;
					}
				}
				batch.forEach((id) => seen.add(id));
			} catch (error) {
				if (error instanceof FatalError) throw error;
				status.warnings.push(`hydrate: ${error.message}`.slice(0, 200));
			}
			await sleep(250);
		}

		// 3) Favorites + names for new items, and re-check stale ones
		const missing = new Set();
		const stale = [];
		for (const cand of Object.values(cands)) {
			for (const [id] of cand.a) { const k = `a${id}`; if (!items[k]) missing.add(k); else if (today - items[k][2] > REFRESH_DAYS) stale.push(k); }
			for (const id of cand.b) { const k = `b${id}`; if (!items[k]) missing.add(k); }
		}
		const toCheck = [...missing, ...[...new Set(stale)].slice(0, REFRESH_LIMIT)];
		for (let i = 0; i < toCheck.length; i += DETAILS_BATCH) {
			try {
				const sample = await details(toCheck.slice(i, i + DETAILS_BATCH), items, today);
				debug['sample-item'] ??= sample;
				status.itemsChecked += Math.min(DETAILS_BATCH, toCheck.length - i);
			} catch (error) {
				if (error instanceof FatalError) throw error;
				status.warnings.push(`details: ${error.message}`.slice(0, 200));
			}
			await sleep(300);
		}
	} finally {
		await save();
	}
	console.log(`Done: ${status.newCandidates} new on-theme looks. Pool: ${status.pool.male} male + ${status.pool.female} female.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`::error::${error.message}`);
		process.exit(1);
	});
}
