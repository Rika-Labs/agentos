import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { preflightForkPublication } from "./npm.js";
import type { Package } from "./packages.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
	cleanup.splice(0).forEach((fn) => fn());
});

function artifact(name: string, version = "1.2.3"): Package {
	const root = mkdtempSync(join(tmpdir(), "npm-preflight-"));
	mkdirSync(join(root, "package"));
	writeFileSync(
		join(root, "package/package.json"),
		JSON.stringify({ name, version }),
	);
	execFileSync("tar", ["-czf", join(root, "package.tgz"), "package"], {
		cwd: root,
	});
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	return {
		name,
		dir: root,
		relDir: name,
		publishPath: join(root, "package.tgz"),
	};
}

async function registry(status: (url: string) => number | "disconnect") {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		const result = status(request.url ?? "");
		if (result === "disconnect") {
			request.socket.destroy();
			return;
		}
		response.writeHead(result);
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("registry did not bind TCP");
	return { url: `http://127.0.0.1:${address.port}`, requests };
}

test("a preexisting native artifact rejects the complete fork release before publication", async () => {
	const local = await registry((url) => (url.includes("native") ? 200 : 404));
	await assert.rejects(
		preflightForkPublication(
			[
				artifact("@rikalabs/agentos-native-linux-x64"),
				artifact("@rikalabs/agentos-client"),
			],
			local.url,
		),
		/already exists; publish all artifacts with a new version/,
	);
	assert.equal(local.requests.length, 2);
});

test("a registry network error fails fork publication closed", async () => {
	const local = await registry(() => "disconnect");
	await assert.rejects(
		preflightForkPublication([artifact("@rikalabs/agentos-client")], local.url),
		/fetch failed/,
	);
});

test("registry 404 allows a new fork release version", async () => {
	const local = await registry(() => 404);
	await preflightForkPublication(
		[
			artifact("@rikalabs/agentos-native-linux-x64"),
			artifact("@rikalabs/agentos-client"),
		],
		local.url,
	);
	assert.equal(local.requests.length, 2);
});
