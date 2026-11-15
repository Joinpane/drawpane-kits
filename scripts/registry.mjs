/**
 * What the registry's scripts share: reading our own kits, checking them
 * against the rules for kits hosted here, and turning them and Penpot's
 * listing into one index entry shape.
 *
 * The licence rules (an allowed SPDX licence, an attribution, a checked file
 * of at most 25 MB) apply to kits hosted here only. Penpot's entries are
 * passed through as Penpot publishes them (scripts/penpot-hub.mjs).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";

export const MAX_BYTES = 25 * 1024 * 1024;
export const ALLOWED_LICENCES = new Set([
  "MIT",
  "Apache-2.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "OFL-1.1",
  "MPL-2.0",
  "CC0-1.0",
]);
/** Licences that ask for credit: the attribution must name the licence. */
const NEEDS_CREDIT = new Set(["CC-BY-4.0", "CC-BY-SA-4.0"]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const COVER_SIZE = { width: 1390, height: 724 };

const root = new URL("..", import.meta.url).pathname;
const schema = JSON.parse(await readFile(join(root, "schema/kit.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

/** Each kit folder's kit.json, parsed (or the reason it didn't parse). */
export async function readKits(dir) {
  let names = [];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const kits = [];
  for (const name of names) {
    const path = join(dir, name, "kit.json");
    try {
      kits.push({ folder: name, dir: join(dir, name), kit: JSON.parse(await readFile(path, "utf8")) });
    } catch (error) {
      kits.push({ folder: name, dir: join(dir, name), kit: null, error: `kit.json: ${error.message}` });
    }
  }
  return kits;
}

async function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A kit's file: from its folder, or downloaded when it names an https URL. */
async function fileBytes(dir, url) {
  if (/^https:\/\//.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`file: ${url} answered ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_BYTES) throw new Error(`file: larger than 25 MB (${length} bytes)`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (url.includes("..") || url.startsWith("/")) throw new Error("file: must be in the kit's folder");
  return readFile(join(dir, url));
}

/** Every problem with a kit hosted here, in words. Empty when it's fine. */
export async function checkKit({ folder, dir, kit, error }, { files = true } = {}) {
  if (error) return [error];
  const problems = [];
  if (!validateSchema(kit)) {
    for (const e of validateSchema.errors ?? [])
      problems.push(`kit.json${e.instancePath || ""}: ${e.message}`);
    return problems;
  }
  if (kit.id !== folder) problems.push(`id "${kit.id}" must match its folder "${folder}"`);
  if (kit.id.startsWith("penpot-")) problems.push("ids starting with penpot- are Penpot's");
  if (!ALLOWED_LICENCES.has(kit.licence.spdx))
    problems.push(`licence ${kit.licence.spdx} isn't one the registry allows`);
  const credit = kit.attribution;
  if (!credit.includes(kit.name)) problems.push("attribution must name the kit");
  if (!credit.includes(kit.author.name)) problems.push("attribution must name the author");
  if (NEEDS_CREDIT.has(kit.licence.spdx)) {
    const version = kit.licence.spdx.replace(/^CC-/, "CC ").replace(/-4\.0$/, " 4.0");
    if (!credit.includes(version)) problems.push(`attribution must name the licence (${version})`);
    if (!credit.includes(kit.licence.url)) problems.push("attribution must link the licence");
    if (kit.modified && !/convert|adapt|modif/i.test(credit))
      problems.push("attribution must say the kit was converted from the original");
  }
  if (files) {
    try {
      const bytes = await fileBytes(dir, kit.file.url);
      if (bytes.length > MAX_BYTES) problems.push("file: larger than 25 MB");
      if (bytes.length !== kit.file.bytes)
        problems.push(`file: ${bytes.length} bytes, kit.json says ${kit.file.bytes}`);
      const sha = await sha256Of(bytes);
      if (sha !== kit.file.sha256) problems.push(`file: sha256 is ${sha}, kit.json says ${kit.file.sha256}`);
    } catch (e) {
      problems.push(e.message);
    }
    try {
      const cover = await readFile(join(dir, kit.cover));
      if (!cover.subarray(0, 8).equals(PNG)) problems.push("cover: not a PNG");
      else {
        const width = cover.readUInt32BE(16);
        const height = cover.readUInt32BE(20);
        if (width !== COVER_SIZE.width || height !== COVER_SIZE.height)
          problems.push(`cover: ${width} x ${height}, covers are ${COVER_SIZE.width} x ${COVER_SIZE.height}`);
      }
    } catch {
      problems.push(`cover: ${kit.cover} is missing`);
    }
  }
  return problems;
}

/** A kit hosted here as an index entry; paths are relative to index.json. */
export function entryOf(kit, folderPath) {
  const local = !/^https:\/\//.test(kit.file.url);
  return {
    id: kit.id,
    name: kit.name,
    provider: "drawpane",
    kind: kit.kind,
    categories: kit.tags,
    description: kit.description,
    author: kit.author,
    source: { name: kit.author.name, page: kit.source.page, repository: kit.source.file ?? null },
    licence: { spdx: kit.licence.spdx, url: kit.licence.url, text: null },
    attribution: kit.attribution,
    modified: kit.modified,
    file: {
      url: local ? `${folderPath}/${kit.file.url}` : kit.file.url,
      format: kit.file.format,
      bytes: kit.file.bytes,
      sha256: kit.file.sha256,
    },
    cover: `${folderPath}/${kit.cover}`,
    published: kit.added,
    updated: kit.added,
  };
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
