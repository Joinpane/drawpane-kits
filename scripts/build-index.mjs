#!/usr/bin/env node
/**
 * index.json: every kit hosted here (kits/<id>/kit.json) and every entry of
 * Penpot's hub (sources/penpot.json), in one list Drawpane reads.
 *
 * Usage: node scripts/build-index.mjs [--check]
 * With --check it writes nothing and fails when index.json isn't what the
 * sources make (CI runs this, so the index can't drift from them).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entryOf, readKits } from "./registry.mjs";

const root = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

const own = (await readKits(join(root, "kits")))
  .filter((k) => k.kit)
  .map((k) => entryOf(k.kit, `kits/${k.folder}`));
const penpot = JSON.parse(await readFile(join(root, "sources/penpot.json"), "utf8"));

const index = {
  format: 1,
  name: "Drawpane kits",
  homepage: "https://github.com/Joinpane/drawpane-kits",
  sources: [
    { provider: "drawpane", name: "Drawpane kits", count: own.length },
    {
      provider: "penpot",
      name: "Penpot's libraries and templates hub",
      page: penpot.hub,
      repository: penpot.repository,
      count: penpot.kits.length,
    },
  ],
  kits: [...own, ...penpot.kits],
};
const ids = new Set();
for (const kit of index.kits) {
  if (ids.has(kit.id)) throw new Error(`Two kits have the id ${kit.id}.`);
  ids.add(kit.id);
}
const text = `${JSON.stringify(index, null, 2)}\n`;
const path = join(root, "index.json");
if (check) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {}
  if (current !== text) {
    console.error("index.json is out of date: run `npm run index` and commit it.");
    process.exit(1);
  }
  console.log(`index.json is up to date (${index.kits.length} kits).`);
} else {
  await writeFile(path, text);
  console.log(`index.json: ${own.length} hosted here, ${penpot.kits.length} from Penpot's hub.`);
}
