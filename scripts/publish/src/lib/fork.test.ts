import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	assertRikaNpmPackages,
	prepareRikaNpmPackage,
	releasePackageName,
	releasePayloadText,
} from "./fork.js";

test("maps every lockstep release package into the @rikalabs scope", () => {
	assert.equal(releasePackageName("@rivet-dev/agentos"), "@rikalabs/agentos");
	assert.equal(
		releasePackageName("@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu"),
		"@rikalabs/agentos-runtime-sidecar-linux-x64-gnu",
	);
	assert.equal(
		releasePackageName("@agentos-software/common"),
		"@rikalabs/agentos-software-common",
	);
	assert.equal(
		releasePackageName("@agentos-software/apps-builder"),
		"@rikalabs/agentos-software-apps-builder",
	);
	assert.equal(
		releasePackageName("@agentos-software/sh"),
		"@rikalabs/agentos-software-sh",
	);
	assert.equal(
		releasePackageName("@agentos-software/tar"),
		"@agentos-software/tar",
	);
});

test("packs a disposable installable resolver fixture after lifecycle scripts run", (t) => {
	const root = mkdtempSync(join(tmpdir(), "rika-pack-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "pkg");
	const output = join(root, "out");
	mkdirSync(pkg);
	mkdirSync(output);
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@rivet-dev/agentos-runtime-sidecar",
			version: "1.2.3",
			main: "index.js",
			files: ["index.js", "bin", "lifecycle.txt"],
			dependencies: { "@rivet-dev/agentos-core": "1.2.3" },
			optionalDependencies: {
				"@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu": "1.2.3",
			},
			scripts: { prepack: "node prepack.cjs" },
		}),
	);
	writeFileSync(
		join(pkg, "prepack.cjs"),
		"require('fs').writeFileSync('lifecycle.txt', 'ran')",
	);
	writeFileSync(
		join(pkg, "index.js"),
		"module.exports = require.resolve('@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu/agentos-native-sidecar')",
	);
	writeFileSync(join(pkg, "bin"), "fixture");
	chmodSync(join(pkg, "bin"), 0o755);
	const sourceManifest = readFileSync(join(pkg, "package.json"), "utf8");
	const sourceIndex = readFileSync(join(pkg, "index.js"), "utf8");
	const filename = prepareRikaNpmPackage(pkg, output);
	assert.equal(readFileSync(join(pkg, "package.json"), "utf8"), sourceManifest);
	assert.equal(readFileSync(join(pkg, "index.js"), "utf8"), sourceIndex);
	const extracted = join(root, "extracted");
	mkdirSync(extracted);
	execFileSync("tar", ["-xzf", join(output, filename), "-C", extracted]);
	const manifest = JSON.parse(
		readFileSync(join(extracted, "package/package.json"), "utf8"),
	);
	assert.equal(manifest.name, "@rikalabs/agentos-runtime-sidecar");
	assert.deepEqual(manifest.dependencies, {
		"@rikalabs/agentos-core": "1.2.3",
	});
	assert.deepEqual(manifest.optionalDependencies, {
		"@rikalabs/agentos-runtime-sidecar-linux-x64-gnu": "1.2.3",
	});
	assert.match(
		readFileSync(join(extracted, "package/index.js"), "utf8"),
		/@rikalabs\/agentos-runtime-sidecar-linux-x64-gnu/,
	);
	assert.equal(
		readFileSync(join(extracted, "package/lifecycle.txt"), "utf8"),
		"ran",
	);
	assert.ok(statSync(join(extracted, "package/bin")).mode & 0o111);
	const platform = join(
		extracted,
		"package/node_modules/@rikalabs/agentos-runtime-sidecar-linux-x64-gnu",
	);
	mkdirSync(platform, { recursive: true });
	writeFileSync(
		join(platform, "package.json"),
		JSON.stringify({
			name: "@rikalabs/agentos-runtime-sidecar-linux-x64-gnu",
			exports: { "./agentos-native-sidecar": "./agentos-native-sidecar" },
		}),
	);
	writeFileSync(join(platform, "agentos-native-sidecar"), "binary");
	assert.equal(
		execFileSync(
			"node",
			["-p", "require(process.argv[1])", join(extracted, "package")],
			{ encoding: "utf8" },
		).trim(),
		// require.resolve reports the realpath'd target (macOS /var ->
		// /private/var), so compare against the resolved expected path.
		realpathSync(join(platform, "agentos-native-sidecar")),
	);
});

function createGuardFixture(
	t: TestContext,
	packageJson: Record<string, unknown>,
	index: string,
) {
	const root = mkdtempSync(join(tmpdir(), "rika-guard-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "packages/core");
	const packed = join(root, "packed");
	const output = join(root, "target/rika-npm");
	mkdirSync(source, { recursive: true });
	mkdirSync(packed);
	mkdirSync(output, { recursive: true });
	writeFileSync(
		join(root, "pnpm-workspace.yaml"),
		"packages:\n  - packages/*\n",
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture", private: true }),
	);
	writeFileSync(
		join(source, "package.json"),
		JSON.stringify({ name: "@rivet-dev/agentos-core", version: "1.2.3" }),
	);
	writeFileSync(
		join(packed, "package.json"),
		JSON.stringify({
			name: "@rikalabs/agentos-core",
			version: "1.2.3",
			...packageJson,
		}),
	);
	writeFileSync(join(packed, "index.js"), index);
	const filename = (
		JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", output],
				{ cwd: packed, encoding: "utf8" },
			),
		)[0] as { filename: string }
	).filename;
	writeFileSync(
		join(output, "manifest.json"),
		JSON.stringify({ "@rikalabs/agentos-core": filename }),
	);
	return root;
}

test("rejects a packed runtime dependency missing from the release closure", (t) => {
	const root = createGuardFixture(
		t,
		{ dependencies: { "@rikalabs/agentos-missing": "1.2.3" } },
		"export {};",
	);
	assert.throws(
		() => assertRikaNpmPackages(root),
		/unpublished runtime dependency @rikalabs\/agentos-missing/,
	);
});

test("rejects upstream imports regenerated by prepack", (t) => {
	const root = createGuardFixture(
		t,
		{},
		"export * from '@rivet-dev/agentos-runtime-core';",
	);
	assert.throws(
		() => assertRikaNpmPackages(root),
		/payload still references @rivet-dev\/agentos/,
	);
});

test("rejects a selected native platform artifact missing its binary", (t) => {
	const root = mkdtempSync(join(tmpdir(), "rika-binary-guard-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "packages/runtime-sidecar/npm/linux-x64-gnu");
	const packed = join(root, "packed");
	const output = join(root, "target/rika-npm");
	mkdirSync(source, { recursive: true });
	mkdirSync(packed);
	mkdirSync(output, { recursive: true });
	writeFileSync(
		join(root, "pnpm-workspace.yaml"),
		"packages:\n  - packages/runtime-sidecar/npm/*\n",
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture", private: true }),
	);
	writeFileSync(
		join(source, "package.json"),
		JSON.stringify({
			name: "@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu",
			version: "1.2.3",
		}),
	);
	writeFileSync(
		join(packed, "package.json"),
		JSON.stringify({
			name: "@rikalabs/agentos-runtime-sidecar-linux-x64-gnu",
			version: "1.2.3",
		}),
	);
	const filename = (
		JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", output],
				{ cwd: packed, encoding: "utf8" },
			),
		)[0] as { filename: string }
	).filename;
	writeFileSync(
		join(output, "manifest.json"),
		JSON.stringify({
			"@rikalabs/agentos-runtime-sidecar-linux-x64-gnu": filename,
		}),
	);
	assert.throws(
		() => assertRikaNpmPackages(root),
		/packed artifact is missing binary: package\/agentos-native-sidecar/,
	);
});

test("rewrites compiled imports, dynamic sidecar resolution, and manifest dependency keys", () => {
	const payload = releasePayloadText(`
import { AgentOS } from "@rivet-dev/agentos-core";
const sidecar = require("@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu");
const manifest = { "@agentos-software/common": "workspace:*", "@agentos-software/sh": "workspace:*" };
`);
	assert.match(payload, /from "@rikalabs\/agentos-core"/);
	assert.match(
		payload,
		/require\("@rikalabs\/agentos-runtime-sidecar-linux-x64-gnu"\)/,
	);
	assert.match(payload, /"@rikalabs\/agentos-software-common"/);
	assert.match(payload, /"@rikalabs\/agentos-software-sh"/);
	assert.doesNotMatch(
		payload,
		/@rivet-dev\/agentos|@agentos-software\/(?:common|apps-builder|sh)/,
	);
});
