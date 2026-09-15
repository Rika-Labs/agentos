// Installs the staged @rikalabs tarballs into a clean app dir for the
// pre-publish smoke test.
//
// `npm install <dir>/*.tgz` cannot associate the unscoped tarball filenames
// (`rikalabs-agentos-core-*.tgz`) with the scoped package names inside, so it
// re-resolves every inter-package version/peer range against the registry —
// which 404s before the packages are published. Declaring the tarballs as
// `file:` deps under their real names fixes the version ranges but not
// `peerOptional` lookups.
//
// What works: install only the EXTERNAL (non-@rikalabs) deps through npm so
// peer resolution stays fully inside the public registry, then unpack the
// staged tarballs into node_modules under their real names. npm never sees
// the rika packages, so nothing re-resolves them.
//
// Usage: node install-staged-app.mjs <tarballDir> <appDir>
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [tarballDir, appDir] = process.argv.slice(2);
if (!tarballDir || !appDir) {
	console.error("usage: node install-staged-app.mjs <tarballDir> <appDir>");
	process.exit(2);
}

const tarballs = readdirSync(tarballDir)
	.filter((f) => f.endsWith(".tgz"))
	.map((f) => join(tarballDir, f));
if (tarballs.length === 0) {
	console.error(`no .tgz files in ${tarballDir}`);
	process.exit(1);
}

const readManifest = (tgz) =>
	JSON.parse(
		execFileSync("tar", ["-xOf", tgz, "package/package.json"], {
			encoding: "utf8",
		}),
	);

const packages = tarballs.map((tgz) => ({ tgz, manifest: readManifest(tgz) }));

// Merge every non-@rikalabs dep the packages declare into the app manifest.
// Conflicting specs keep the first occurrence (matches npm's hoisted-tree
// tolerance); a conflict only matters if the smoke actually loads both.
const externals = new Map();
for (const { manifest } of packages) {
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (name.startsWith("@rikalabs/")) continue;
			if (!externals.has(name)) externals.set(name, spec);
		}
	}
}

await mkdir(appDir, { recursive: true });
await writeFile(
	join(appDir, "package.json"),
	JSON.stringify(
		{ private: true, type: "module", dependencies: Object.fromEntries(externals) },
		null,
		2,
	) + "\n",
);

console.log(`installing ${externals.size} external deps into ${appDir}`);
execFileSync(
	"npm",
	["install", "--no-audit", "--no-fund", "--package-lock=false"],
	{ cwd: appDir, stdio: "inherit" },
);

for (const { tgz, manifest } of packages) {
	const dest = join(appDir, "node_modules", manifest.name);
	await mkdir(dirname(dest), { recursive: true });
	await mkdir(dest, { recursive: true });
	execFileSync("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"]);
	console.log(`staged ${manifest.name}@${manifest.version}`);
}
console.log(`staged ${packages.length} @rikalabs packages`);
