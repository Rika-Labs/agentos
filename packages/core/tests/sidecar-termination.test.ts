import { StdioSidecarProtocolClient } from "@rivet-dev/agentos-runtime-core/native-client";
import { SidecarProcess } from "@rivet-dev/agentos-runtime-core/sidecar-client";
import { afterEach, expect, test, vi } from "vitest";
import { AgentOs } from "../src/agent-os.js";
import { AgentOsSidecarClient } from "../src/sidecar/rpc-client.js";

afterEach(() => {
	vi.restoreAllMocks();
});

test("a terminated handle cannot start a new native process", async () => {
	const sidecar = await AgentOs.createSidecar();
	const spawn = vi.spyOn(StdioSidecarProtocolClient, "spawn");
	const first = sidecar.terminate();
	expect(sidecar.terminate()).toBe(first);
	await first;
	await expect(
		AgentOs.create({ sidecar: { kind: "explicit", handle: sidecar } }),
	).rejects.toThrow();
	expect(spawn).not.toHaveBeenCalled();
	expect(sidecar.describe().state).toBe("disposed");
});

test("client disposal retries a failed VM stop", async () => {
	const stop = vi.fn().mockRejectedValueOnce(new Error("stop failed"));
	const client = new AgentOsSidecarClient({
		createId: vi.fn().mockReturnValueOnce("session").mockReturnValueOnce("vm"),
		createOwnershipTransport: async () => ({
			createVm: async () => {},
			disposeVm: stop,
			dispose: async () => {},
		}),
	});
	const session = await client.createOwnershipSession();
	await session.createVm();
	await expect(client.dispose()).rejects.toThrow("stop failed");
	stop.mockResolvedValue(undefined);
	await client.dispose();
	expect(stop).toHaveBeenCalledTimes(2);
});

test("termination does not wait for stalled authentication", async () => {
	const started = Promise.withResolvers<void>();
	const authentication =
		Promise.withResolvers<
			Awaited<ReturnType<SidecarProcess["authenticateAndOpenSession"]>>
		>();
	vi.spyOn(
		SidecarProcess.prototype,
		"authenticateAndOpenSession",
	).mockImplementation(() => {
		started.resolve();
		return authentication.promise;
	});
	const sidecar = await AgentOs.createSidecar();
	const creating = AgentOs.create({
		sidecar: { kind: "explicit", handle: sidecar },
	});
	const outcome = creating.then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await started.promise;
		const first = sidecar.terminate();
		expect(sidecar.terminate()).toBe(first);
		await first;
		expect(sidecar.describe().state).toBe("disposed");
	} finally {
		authentication.reject(new Error("injected authentication failure"));
		expect(await outcome).toEqual(new Error("injected authentication failure"));
		await sidecar.terminate();
	}
	expect(sidecar.describe().state).toBe("disposed");
});

test("failed startup retains the native owner when killing is refused", async () => {
	const spawn = StdioSidecarProtocolClient.spawn.bind(
		StdioSidecarProtocolClient,
	);
	const clients: StdioSidecarProtocolClient[] = [];
	vi.spyOn(StdioSidecarProtocolClient, "spawn").mockImplementation(
		(options) => {
			const client = spawn(options);
			clients.push(client);
			vi.spyOn(client.child, "kill").mockReturnValue(false);
			return client;
		},
	);
	vi.spyOn(
		SidecarProcess.prototype,
		"authenticateAndOpenSession",
	).mockRejectedValue(new Error("authentication failed"));
	const sidecar = await AgentOs.createSidecar();
	try {
		await expect(
			AgentOs.create({ sidecar: { kind: "explicit", handle: sidecar } }),
		).rejects.toThrow("termination remains unconfirmed");
		expect(clients).toHaveLength(1);
		expect(clients[0].child.exitCode).toBeNull();
		expect(clients[0].child.signalCode).toBeNull();
		expect(sidecar.describe().state).toBe("disposing");
	} finally {
		vi.restoreAllMocks();
		await sidecar.terminate();
	}
	expect(
		clients[0].child.exitCode !== null || clients[0].child.signalCode !== null,
	).toBe(true);
	expect(sidecar.describe().state).toBe("disposed");
});

test("concurrent refused termination shares one failed attempt and a later retry succeeds", async () => {
	const spawn = StdioSidecarProtocolClient.spawn.bind(
		StdioSidecarProtocolClient,
	);
	let client: StdioSidecarProtocolClient | undefined;
	vi.spyOn(StdioSidecarProtocolClient, "spawn").mockImplementation(
		(options) => {
			client = spawn({ ...options, forceExitMs: 10 });
			return client;
		},
	);
	const sidecar = await AgentOs.createSidecar();
	const vm = await AgentOs.create({
		sidecar: { kind: "explicit", handle: sidecar },
	});
	const kill = vi.spyOn(client!.child, "kill").mockReturnValue(false);
	const first = sidecar.terminate();
	const concurrent = sidecar.terminate();
	expect(concurrent).toBe(first);
	await expect(first).rejects.toThrow("termination was not confirmed");
	expect(kill).toHaveBeenCalledTimes(1);
	expect(client!.child.exitCode).toBeNull();
	expect(client!.child.signalCode).toBeNull();
	expect(sidecar.describe().state).toBe("disposing");

	kill.mockRestore();
	await sidecar.terminate();
	expect(
		client!.child.exitCode !== null || client!.child.signalCode !== null,
	).toBe(true);
	expect(sidecar.describe().state).toBe("disposed");
	await vm.dispose();
});
