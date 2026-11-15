#!/usr/bin/env node
/**
 * Penpot's libraries and templates hub, as a source for the registry.
 *
 * Penpot's hub is passed through as Penpot publishes it: nothing here is
 * curated, renamed or filtered. Every `.penpot` file in penpot/penpot-files
 * becomes an entry, and the hub's page for it (when there is one) adds its
 * title, author, description, categories and cover. A `<name>.LICENSE` file
 * beside the export is carried as Penpot provides it (its text and link);
 * without one, the entry says the licence isn't stated and links to the hub.
 *
 * Files stay on Penpot's public hosting (penpot.github.io, which serves the
 * repository's main branch); entries only point at them. Each entry records
 * the file's size and git blob SHA-1 from the repository, so Drawpane can
 * check the download is the file listed here.
 *
 * Usage: node scripts/penpot-hub.mjs [out=sources/penpot.json]
 * A scheduled workflow runs it daily (.github/workflows/penpot-hub.yml).
 */
import { writeFile } from "node:fs/promises";

const REPO = "penpot/penpot-files";
const PAGES = "https://penpot.github.io/penpot-files/";
/** The hub links some downloads to the repository's raw files instead. */
const RAW = `https://github.com/${REPO}/raw/refs/heads/main/`;
const HUB = "https://penpot.app/penpothub/libraries-templates";
const HUB_PAGE = /href="\/penpothub\/libraries-templates\/([A-Za-z0-9][A-Za-z0-9._-]*)\s*"/g;
/** Hub pages that aren't entries. */
const NOT_ENTRIES = new Set(["guides", "submit"]);
const UA = "kit-registry-sync/1.0";
const CONCURRENCY = 4;

const out = process.argv[2] ?? "sources/penpot.json";

async function get(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: { "user-agent": UA, ...(init.headers ?? {}) },
    });
    if (response.ok) return response;
    if (response.status === 404) return null;
    if (attempt >= 3) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

/** The repository's top-level files: name, size and git blob SHA-1. */
async function repoFiles() {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await get(`https://api.github.com/repos/${REPO}/contents/`, { headers });
  if (!response) throw new Error(`${REPO} not found`);
  const list = await response.json();
  return list.filter((f) => f.type === "file");
}

/** The repository file a hub download link points at, if it's one of Penpot's. */
function fileNameOf(url) {
  const prefix = [PAGES, RAW].find((p) => url?.startsWith(p));
  if (!prefix) return null;
  try {
    return decodeURIComponent(url.slice(prefix.length).replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

const unescape = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");

/** What a hub page says about its entry: from its schema.org CreativeWork and its buttons. */
function readHubPage(slug, html) {
  let work = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    try {
      const data = JSON.parse(m[1]);
      if (data["@type"] === "CreativeWork") work = data;
    } catch {
      // Not ours to fix: another block on the page.
    }
  }
  const download = /<a[^>]*href="([^"]+)"[^>]*\bdownload\b[^>]*>/.exec(html)?.[1];
  const date = (label) => {
    const at = html.indexOf(`${label}:`);
    if (at < 0) return null;
    const text = html
      .slice(at, at + 400)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const m = new RegExp(`${label}: ([A-Z][a-z]{2} \\d{1,2}, \\d{4})`).exec(text);
    if (!m) return null;
    const d = new Date(`${m[1]} UTC`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  return {
    slug,
    page: `${HUB}/${slug}`,
    name: work?.name ? unescape(work.name) : null,
    description: work?.description ? unescape(work.description) : null,
    author: work?.author?.name ? unescape(work.author.name) : null,
    categories: work?.keywords
      ? work.keywords
          .split(",")
          .map((k) => unescape(k.trim()))
          .filter(Boolean)
      : [],
    cover: typeof work?.image === "string" && work.image.startsWith("https://") ? work.image : null,
    download: download ? unescape(download) : null,
    published: date("Published"),
    updated: date("Last update"),
  };
}

async function hubEntries() {
  const listing = await get(HUB);
  if (!listing) throw new Error("The hub's listing is gone.");
  const slugs = [...new Set([...(await listing.text()).matchAll(HUB_PAGE)].map((m) => m[1]))]
    .filter((s) => !NOT_ENTRIES.has(s))
    .sort();
  const entries = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < slugs.length) {
        const slug = slugs[next++];
        const page = await get(`${HUB}/${slug}`);
        if (page) entries.push(readHubPage(slug, await page.text()));
      }
    }),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Penpot's categories as a broad kind Drawpane can filter by (the categories are kept as given). */
function kindOf(categories) {
  const c = categories.map((s) => s.toLowerCase());
  if (c.some((s) => s.includes("icon"))) return "icons";
  if (c.some((s) => s.includes("wirefram"))) return "wireframe";
  if (c.some((s) => s.includes("ui kit") || s.includes("design system"))) return "ui-kit";
  if (c.some((s) => s.includes("librar"))) return "library";
  if (c.some((s) => s.includes("template"))) return "template";
  return "other";
}

/**
 * What kind of file an export is, from its first bytes (a range request, so
 * nothing is downloaded): a zip (Penpot's current binfile v3), Penpot's older binfile
 * v1, binfile v2 (SQLite), or a Git LFS pointer, which is what Pages serves
 * for a file kept in LFS. Drawpane says up front what it can't import.
 */
async function containerOf(url) {
  const response = await get(url, { headers: { range: "bytes=0-31" } });
  if (!response) return null;
  const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, 32);
  const text = new TextDecoder("latin1").decode(bytes);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  if (bytes[0] === 0x01 && bytes[1] === 0x0b && bytes[2] === 0x1a && bytes[3] === 0x86) return "binfile-v1";
  if (text.startsWith("SQLite format 3")) return "binfile-v2";
  if (text.startsWith("version https://git-lfs")) return "lfs-pointer";
  return "unknown";
}

/** A stable id from the file name: lower case, dashes. */
const idOf = (fileName) =>
  `penpot-${fileName
    .replace(/\.penpot$/i, "")
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/_/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()}`;

const pagesUrl = (name) => PAGES + encodeURIComponent(name).replace(/%2F/g, "/");
const blobUrl = (name) =>
  `https://github.com/${REPO}/blob/main/${encodeURIComponent(name).replace(/%2F/g, "/")}`;

async function main() {
  const [files, hub] = await Promise.all([repoFiles(), hubEntries()]);
  const byName = new Map(files.map((f) => [f.name, f]));
  const licences = new Map();
  for (const f of files) {
    if (!f.name.endsWith(".LICENSE")) continue;
    const response = await get(pagesUrl(f.name));
    if (response) licences.set(f.name.replace(/\.LICENSE$/, ""), await response.text());
  }

  const hubByFile = new Map();
  for (const entry of hub) {
    const name = fileNameOf(entry.download);
    if (name && byName.has(name) && !hubByFile.has(name)) hubByFile.set(name, entry);
  }

  const containers = new Map();
  const exports = files.filter((f) => /\.penpot$/i.test(f.name));
  let nextFile = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (nextFile < exports.length) {
        const f = exports[nextFile++];
        containers.set(f.name, await containerOf(pagesUrl(f.name)));
      }
    }),
  );

  const kits = [];
  const seen = new Set();
  for (const file of files) {
    if (!/\.penpot$/i.test(file.name)) continue;
    const base = file.name.replace(/\.penpot$/i, "");
    const hubEntry = hubByFile.get(file.name) ?? null;
    let id = idOf(file.name);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const licenceText = licences.get(base) ?? null;
    kits.push({
      id,
      name: hubEntry?.name ?? base,
      provider: "penpot",
      kind: kindOf(hubEntry?.categories ?? []),
      categories: hubEntry?.categories ?? [],
      description: hubEntry?.description ?? null,
      author: hubEntry?.author ? { name: hubEntry.author } : null,
      source: {
        name: "Penpot's libraries and templates hub",
        page: hubEntry?.page ?? null,
        repository: blobUrl(file.name),
      },
      licence: licenceText
        ? { text: licenceText.trim(), url: blobUrl(`${base}.LICENSE`) }
        : null,
      file: {
        url: pagesUrl(file.name),
        format: "penpot",
        bytes: file.size,
        gitSha1: file.sha,
        container: containers.get(file.name) ?? null,
      },
      cover: hubEntry?.cover ?? null,
      published: hubEntry?.published ?? null,
      updated: hubEntry?.updated ?? null,
    });
  }

  // Hub pages whose file isn't in the repository (another host, or gone): listed as the hub has them.
  for (const entry of hub) {
    const name = fileNameOf(entry.download);
    if (name && byName.has(name)) continue;
    // A download that isn't a file (a link to a pull request, say) leaves the entry without one.
    const file = /\.penpot($|\?)/i.test(entry.download ?? "") ? entry.download : null;
    let id = `penpot-hub-${entry.slug.toLowerCase()}`;
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    kits.push({
      id,
      name: entry.name ?? entry.slug,
      provider: "penpot",
      kind: kindOf(entry.categories),
      categories: entry.categories,
      description: entry.description,
      author: entry.author ? { name: entry.author } : null,
      source: { name: "Penpot's libraries and templates hub", page: entry.page, repository: null },
      licence: null,
      file: file ? { url: file, format: "penpot", bytes: null, gitSha1: null, container: null } : null,
      cover: entry.cover,
      published: entry.published,
      updated: entry.updated,
    });
  }

  kits.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const source = {
    provider: "penpot",
    hub: HUB,
    repository: `https://github.com/${REPO}`,
    kits,
  };
  await writeFile(out, `${JSON.stringify(source, null, 2)}\n`);
  const withHub = kits.filter((k) => k.source.page).length;
  const withLicence = kits.filter((k) => k.licence).length;
  const byContainer = {};
  for (const k of kits) if (k.file) byContainer[k.file.container] = (byContainer[k.file.container] ?? 0) + 1;
  console.log("Files by container:", byContainer);
  console.log(
    `${kits.length} Penpot entries (${withHub} with a hub page, ${withLicence} with a LICENSE file) → ${out}`,
  );
}

await main();
