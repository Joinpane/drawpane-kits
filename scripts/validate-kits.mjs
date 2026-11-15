#!/usr/bin/env node
/**
 * Checks every kit hosted here: kit.json against the schema, an allowed
 * licence, an attribution that credits it properly, the file's size (25 MB
 * at most) and sha256, and the cover. Penpot's entries aren't checked
 * against these rules: they're Penpot's, passed through as published.
 *
 * Usage: node scripts/validate-kits.mjs [dir=kits]
 */
import { join, resolve } from "node:path";
import { checkKit, readKits } from "./registry.mjs";

const dir = resolve(process.argv[2] ?? join(new URL("..", import.meta.url).pathname, "kits"));
const kits = await readKits(dir);
let failed = 0;
for (const kit of kits) {
  const problems = await checkKit(kit);
  if (problems.length === 0) {
    console.log(`ok   ${kit.folder}`);
    continue;
  }
  failed++;
  console.error(`FAIL ${kit.folder}`);
  for (const p of problems) console.error(`     ${p}`);
}
console.log(`${kits.length} kit${kits.length === 1 ? "" : "s"} checked, ${failed} with problems.`);
if (failed > 0) process.exit(1);
