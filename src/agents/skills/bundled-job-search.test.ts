/**
 * Guards the bundled `job-search` skill — the SHIPPED assets, not fixtures.
 *
 * The skill is data + a script, so nothing else in the suite exercises it;
 * without these checks a broken frontmatter or a syntax-errored tracker
 * script would only surface at a user's first hunt. Two layers:
 *
 *   1. Discovery + spec conformance — the skill is found via the real bundled
 *      root, its frontmatter satisfies the Agent Skills validation Pi applies
 *      (name matches dir, lowercase kebab, description present ≤ 1024 chars),
 *      and it declares no eligibility constraints (it's keyless by design).
 *   2. The tracker script actually works — a real `node` child process runs
 *      the shipped ledger through its full loop (add → list → update →
 *      followups → stats → remove) plus its error contract (usage errors vs.
 *      data errors, distinct exit codes).
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { resolveBundledSkillsDir } from "../../config/paths.js";
import { discoverSkills } from "./discovery.js";

/** The repo's shipped skills root (tests elsewhere may override the env). */
function shippedRoot(): string {
	const prev = process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	try {
		return resolveBundledSkillsDir();
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
		else process.env.BRIGADE_BUNDLED_SKILLS_DIR = prev;
	}
}

function skillFile(...parts: string[]): string {
	return path.join(shippedRoot(), "job-search", ...parts);
}

/** Same budget the manage-skill tool enforces for support files. */
const MAX_SUPPORT_FILE_BYTES = 300 * 1024;

/** Local YYYY-MM-DD for `daysAgo` nominal days back. */
function isoDaysAgo(daysAgo: number): string {
	const d = new Date(Date.now() - daysAgo * 86_400_000);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

interface TrackerResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run the shipped tracker as a real child process; never throws on nonzero exit. */
function runTracker(args: string[], cwd: string): Promise<TrackerResult> {
	return new Promise((resolve) => {
		execFile(process.execPath, [skillFile("scripts", "tracker.mjs"), ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err === null) {
				resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
				return;
			}
			const raw = (err as NodeJS.ErrnoException).code;
			const code = typeof raw === "number" ? raw : Number(raw);
			resolve({ code: Number.isFinite(code) ? code : 1, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

describe("bundled job-search skill (shipped assets)", () => {
	it("ships as an eligible bundled skill with no eligibility constraints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-"));
		try {
			const res = discoverSkills({
				workspaceSkillsDir: path.join(root, "empty-ws"),
				bundledSkillsDir: resolveBundledSkillsDir(),
			});
			const js = res.skills.find((s) => s.name === "job-search");
			assert.ok(js, `expected job-search among discovered skills: ${JSON.stringify(res.skills.map((s) => s.name))}`);
			assert.equal(js.source, "bundled");
			assert.equal(js.eligibility.os.length, 0, "keyless skill must not constrain OS");
			assert.equal(js.eligibility.requiresBins.length, 0, "keyless skill must not require binaries");
			assert.equal(js.eligibility.requiresEnv.length, 0, "keyless skill must not require env vars");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frontmatter satisfies the Agent Skills validation Pi applies", () => {
		const dir = path.dirname(skillFile("SKILL.md"));
		assert.equal(path.basename(dir), "job-search", "skill dir name must be job-search");
		const raw = fs.readFileSync(skillFile("SKILL.md"), "utf8");
		assert.ok(raw.length < MAX_SUPPORT_FILE_BYTES, "SKILL.md must stay within the support-file budget");
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		assert.ok(fm, "SKILL.md must open with a frontmatter block");
		const body = fm[1] ?? "";
		const name = /^name:\s*(\S+)\s*$/m.exec(body);
		assert.ok(name, "frontmatter must carry a name");
		const nameValue = name[1] ?? "";
		assert.equal(nameValue, "job-search");
		assert.match(nameValue, /^[a-z0-9-]+$/, "name must be lowercase kebab-case");
		assert.ok(!nameValue.startsWith("-") && !nameValue.endsWith("-") && !nameValue.includes("--"), "name must not game the hyphen rules");
		const description = /^description:\s*(.+)$/m.exec(body);
		assert.ok(description, "frontmatter must carry a description (the discovery hook)");
		const descriptionValue = (description[1] ?? "").trim();
		assert.ok(descriptionValue.length > 0 && descriptionValue.length <= 1024, "description must be 1..1024 chars");
		const tracker = fs.statSync(skillFile("scripts", "tracker.mjs"));
		assert.ok(tracker.isFile() && tracker.size > 0 && tracker.size < MAX_SUPPORT_FILE_BYTES, "tracker script must ship within the support-file budget");
	});

	it("tracker runs the full ledger loop end-to-end", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-run-"));
		try {
			// No --db here on purpose: the loop below runs against the DEFAULT
			// ledger location (<cwd>/job-search/applications.json) and thereby
			// pins the default-path contract the skill's instructions rely on.
			const add = await runTracker(["add", "--company", "Acme Corp", "--role", "Backend Engineer", "--url", "https://acme.example/careers/123", "--source", "linkedin", "--date", isoDaysAgo(9)], work);
			assert.equal(add.code, 0, `add failed: ${add.stderr}`);
			assert.match(add.stdout, /Added #1 — Acme Corp — Backend Engineer/);
			assert.ok(fs.existsSync(path.join(work, "job-search", "applications.json")), "add must create the ledger at the default workspace path");

			const add2 = await runTracker(["add", "--company", "Globex", "--role", "Platform Engineer"], work);
			assert.equal(add2.code, 0, `second add failed: ${add2.stderr}`);
			assert.match(add2.stdout, /Added #2/);

			const list = await runTracker(["list"], work);
			assert.equal(list.code, 0);
			assert.match(list.stdout, /#1\s+.*Acme Corp\s+.*Backend Engineer\s+.*applied/);
			assert.match(list.stdout, /#2\s+.*Globex/);

			const update = await runTracker(["update", "2", "--status", "interview", "--notes", "Tech screen Thu 2pm"], work);
			assert.equal(update.code, 0, `update failed: ${update.stderr}`);
			assert.match(update.stdout, /#2 .*: interview/);

			// #1 was added 9 days ago and never touched → it is the stale one.
			const followups = await runTracker(["followups", "--stale-days", "3"], work);
			assert.equal(followups.code, 0);
			assert.match(followups.stdout, /1 application\(s\) need attention/);
			assert.match(followups.stdout, /#1\s+.*Acme Corp\s+.*Nudge: a short follow-up is overdue/);
			assert.ok(!followups.stdout.includes("#2"), "freshly-updated #2 must not be flagged as stale");

			const stats = await runTracker(["stats"], work);
			assert.equal(stats.code, 0);
			assert.match(stats.stdout, /Applications: 2/);
			assert.match(stats.stdout, /applied 1 \| screening 0 \| interview 1/);
			assert.match(stats.stdout, /Responses: 1\/2 \(50%\)/);

			const filter = await runTracker(["list", "--status", "interview"], work);
			assert.equal(filter.code, 0);
			assert.match(filter.stdout, /Globex/);
			assert.ok(!filter.stdout.includes("Acme Corp"), "status filter must exclude other applications");

			const remove = await runTracker(["remove", "1"], work);
			assert.equal(remove.code, 0);
			assert.match(remove.stdout, /Removed #1/);
			const after = await runTracker(["list"], work);
			assert.ok(!after.stdout.includes("Acme Corp"), "removed application must disappear from the ledger");
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("tracker keeps usage errors and data errors on distinct exit codes", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-err-"));
		try {
			const db = path.join(work, "ledger.json");
			const t = (args: string[]): Promise<TrackerResult> => runTracker(["--db", db, ...args], work);
			assert.equal((await t(["add", "--company", "Acme"])).code, 1, "add without --role is a usage error (exit 1)");
			assert.equal(fs.existsSync(db), false, "a usage error must not create a ledger file");
			const seeded = await t(["add", "--company", "Acme", "--role", "Eng"]);
			assert.equal(seeded.code, 0, `seeding failed: ${seeded.stderr}`);

			const badStatus = await t(["update", "1", "--status", "bogus"]);
			assert.equal(badStatus.code, 1, "invalid status is a usage error (exit 1)");
			assert.match(badStatus.stderr, /--status must be one of:/);

			const badDate = await t(["add", "--company", "X", "--role", "Y", "--date", "2026-02-30"]);
			assert.equal(badDate.code, 1, "a non-existent calendar date is a usage error (exit 1)");
			assert.match(badDate.stderr, /real YYYY-MM-DD calendar date/);

			const unknownId = await t(["show", "99"]);
			assert.equal(unknownId.code, 2, "unknown id is a data error (exit 2)");
			assert.match(unknownId.stderr, /unknown application id #99/);

			fs.writeFileSync(db, '{"oops":true}\n', "utf8");
			const corrupt = await t(["stats"]);
			assert.equal(corrupt.code, 2, "a corrupt ledger is a data error (exit 2)");
			assert.match(corrupt.stderr, /is corrupt/);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});
