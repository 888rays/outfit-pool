// Outfit pool fetcher: searches the Roblox avatars page ("Looks") for styled outfits
// and saves them to pool.json. Only ever ADDS to the pool, so a bad run can't damage it.
// Needs the ROBLOX_COOKIE secret (spare account). Runs on GitHub Actions, no installs needed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const COOKIE = process.env.ROBLOX_COOKIE;
const TARGET = Math.max(100, Number(process.env.POOL_TARGET) || 2000);
const KEYWORDS = (process.env.KEYWORDS || [
	'emo', 'goth', 'gothic', 'grunge', 'scene', 'vkei', 'punk', 'alt', 'emo boy', 'emo girl',
	'goth girl', 'goth boy', 'y2k emo', 'dark aesthetic', 'black outfit', 'cybergoth', 'metal',
	'rocker', 'scene kid', 'trad goth', 'pastel goth', 'e-girl', 'e-boy', 'mall goth', 'vampire',
	'horror', 'witch', 'spooky', 'chains', 'emo y2k', 'skater emo', 'gothic lolita', 'grunge girl',
	'grunge boy', 'dark academia', 'emo hair', 'black and red', 'black and white', 'edgy', 'alt girl',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const API = 'https://apis.roblox.com/marketplace-widgets/v1/widgets';
const SEARCH_DELAY_MS = 1500; // search limit is 60/minute, stay well under it
const HYDRATE_BATCH = 20;
const HYDRATE_DELAY_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

if (!COOKIE) fail('The ROBLOX_COOKIE secret is missing. Add it in Settings > Secrets and variables > Actions.');

let csrfToken = '';

// One request with Roblox's CSRF handshake, retries on throttling/server errors.
// The cookie is never printed.
async function request(url, options = {}, attempt = 1) {
	const headers = {
		Cookie: `.ROBLOSECURITY=${COOKIE}`,
		Accept: 'application/json',
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
		...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
		...(options.headers || {}),
	};
	let response;
	try {
		response = await fetch(url, { ...options, headers });
	} catch (error) {
		if (attempt <= 3) {
			await sleep(3000 * attempt);
			return request(url, options, attempt + 1);
		}
		throw error;
	}

	const token = response.headers.get('x-csrf-token');
	if (response.status === 403 && token && token !== csrfToken && attempt <= 3) {
		csrfToken = token;
		return request(url, options, attempt + 1);
	}
	if (response.status === 401) {
		fail('The login cookie expired or is invalid (401). Get a fresh cookie from the spare account and update ROBLOX_COOKIE.');
	}
	if ((response.status === 429 || response.status >= 500) && attempt <= 4) {
		await sleep((response.status === 429 ? 20000 : 4000) * attempt);
		return request(url, options, attempt + 1);
	}

	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} from ${url.split('?')[0]}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

async function searchLooks(query) {
	const data = await request(`${API}?query=${encodeURIComponent(query)}&context=avatarTab`);
	const ids = [];
	for (const widget of Object.values(data.widgets || {})) {
		for (const item of widget?.content || []) {
			if (item?.type === 'Look' && item.id) ids.push(String(item.id));
		}
	}
	return { ids, raw: data };
}

async function hydrate(lookIds) {
	const data = await request(`${API}/hydrate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ Content: lookIds.map((id) => ({ id, type: 'Look' })) }),
	});
	return data.hydratedContent || [];
}

function toEntry(look) {
	const outfitId = Number(look?.outfitId);
	if (!outfitId) return null;
	const assets = (look.assets || [])
		.map((asset) => ({ id: Number(asset.id), type: asset.assetType ?? null, order: asset.order ?? null }))
		.filter((asset) => asset.id);
	if (assets.length === 0) return null;
	return {
		lookId: String(look.id),
		outfitId,
		name: String(look.name || '').slice(0, 80),
		curator: String(look.curator?.name || ''),
		curatorType: String(look.curator?.type || ''),
		assets,
		bundles: (look.bundles || []).map((bundle) => Number(bundle.id)).filter(Boolean),
		price: Number(look.totalPrice) || 0,
		favorites: Number(look.favoriteCount) || 0,
		// Same items = same outfit, even if it was published twice
		key: assets.map((asset) => asset.id).sort((a, b) => a - b).join(','),
		added: Date.now(),
	};
}

async function main() {
	const existing = await readFile('pool.json', 'utf8').then(JSON.parse).catch(() => ({ outfits: [] }));
	const outfits = Array.isArray(existing.outfits) ? existing.outfits : [];
	const knownLooks = new Set(outfits.map((o) => o.lookId));
	const knownKeys = new Set(outfits.map((o) => o.key));
	const knownOutfits = new Set(outfits.map((o) => o.outfitId));
	console.log(`Pool before: ${outfits.length} outfits. Target: ${TARGET}.`);

	// 1) Search every keyword
	const pending = [];
	let searchesOk = 0;
	let firstSearch = null;
	for (const keyword of KEYWORDS) {
		try {
			const { ids, raw } = await searchLooks(keyword);
			firstSearch ??= raw;
			searchesOk++;
			let fresh = 0;
			for (const id of ids) {
				if (!knownLooks.has(id) && !pending.includes(id)) {
					pending.push(id);
					fresh++;
				}
			}
			console.log(`"${keyword}": ${ids.length} looks (${fresh} new)`);
		} catch (error) {
			console.warn(`::warning::Search "${keyword}" failed: ${error.message}`);
		}
		await sleep(SEARCH_DELAY_MS);
	}
	if (searchesOk === 0) fail('Every search failed. Roblox may have changed the avatars page API. The pool was not touched.');

	// 2) Turn look ids into full outfits (items, bundles, outfit id)
	let added = 0;
	let firstLook = null;
	for (let i = 0; i < pending.length; i += HYDRATE_BATCH) {
		const batch = pending.slice(i, i + HYDRATE_BATCH);
		try {
			for (const look of await hydrate(batch)) {
				firstLook ??= look;
				const entry = toEntry(look);
				if (!entry || knownKeys.has(entry.key) || knownOutfits.has(entry.outfitId)) continue;
				outfits.push(entry);
				knownKeys.add(entry.key);
				knownOutfits.add(entry.outfitId);
				knownLooks.add(entry.lookId);
				added++;
			}
		} catch (error) {
			console.warn(`::warning::Hydrate batch failed: ${error.message}`);
		}
		await sleep(HYDRATE_DELAY_MS);
	}

	// 3) Keep the newest TARGET outfits
	outfits.sort((a, b) => a.added - b.added);
	const trimmed = outfits.slice(Math.max(0, outfits.length - TARGET));

	await writeFile('pool.json', JSON.stringify({ updated: new Date().toISOString(), count: trimmed.length, outfits: trimmed }));
	await writeFile('status.json', JSON.stringify({
		lastRun: new Date().toISOString(), searchesOk, searches: KEYWORDS.length, added, total: trimmed.length,
	}, null, 2));

	// Small samples (no login info) so the import can be checked against Roblox's real format
	await mkdir('debug', { recursive: true });
	if (firstSearch) await writeFile('debug/sample-search.json', JSON.stringify(firstSearch, null, 2).slice(0, 20000));
	if (firstLook) await writeFile('debug/sample-look.json', JSON.stringify(firstLook, null, 2));

	console.log(`Done: ${added} new outfits added, pool is now ${trimmed.length}.`);
}

main().catch((error) => fail(error.message));
