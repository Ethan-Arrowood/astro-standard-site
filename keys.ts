#!/usr/bin/env node
// Usage: astro-standard-site-keys "<glob>"
// Adds a standardSiteRkey to every matching post that lacks one. Run from the
// project root, with the same glob as the integration's `documents.pattern`.

import path from "node:path";

import { fillDocumentKeys } from "./documents.ts";

const pattern = process.argv[2];

if (!pattern) {
	console.error('Usage: astro-standard-site-keys "<glob>"');
	process.exit(1);
}

const changed = await fillDocumentKeys(pattern, process.cwd());

for (const file of changed) {
	console.log(`Added a record key to ${path.relative(process.cwd(), file)}`);
}

console.log(
	changed.length === 0
		? "Every post already has a record key."
		: "Commit these changes. Record keys must not change once published.",
);
