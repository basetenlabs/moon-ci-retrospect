import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { parseJson } from "@moonrepo/dev";

import type { Action, ActionStatus, OperationMetaTaskExecution, RunReport } from "@moonrepo/types";

async function loadReport(workspaceRoot: string): Promise<RunReport | null> {
	for (const fileName of ["ciReport.json", "runReport.json"]) {
		const localPath = path.join(".moon/cache", fileName);

		const reportPath = path.join(workspaceRoot, localPath);

		core.debug(`Finding run report at ${localPath}`);

		if (await fileExists(reportPath)) {
			core.debug("Found!");

			return parseJson<RunReport>(reportPath);
		}
	}

	return null;
}

const failStatuses = new Set<ActionStatus>(["failed", "timed-out", "aborted", "invalid", "failed-and-abort"]);

function sortActionsByFailure(actions: Action[]): Action[] {
	return [...actions].sort((a, b) => {
		const aFailed = failStatuses.has(a.status) ? 0 : 1;
		const bFailed = failStatuses.has(b.status) ? 0 : 1;
		return aFailed - bFailed;
	});
}

async function main(): Promise<void> {
	const root = process.cwd();

	const report = await loadReport(root);

	if (!report) {
		core.warning("Run report does not exist, has `moon ci` or `moon run` ran?");

		return;
	}

	const sortedActions = sortActionsByFailure(report.actions);

	// Workflow log groups (existing behavior)
	for (const action of sortedActions) {
		if (action.node.action !== "run-task") {
			continue;
		}

		const { project, task } = parseTarget(action.node.params.target);
		const target = `${project}:${task}`;

		const command = commandOf(action);

		const { stdout, stderr } = await readStatus(root, { project, task });

		const hasStdout = stdout.trim() !== "";
		const hasStderr = stderr.trim() !== "";

		core.startGroup(`${statusBadges[action.status]} ${bold(target)}`);

		if (typeof command === "string") {
			console.log(blue(`$ ${command}`));
		}

		if (hasStdout) {
			console.log(stdBadges.out);
			console.log(stdout);
		}

		if (hasStderr) {
			console.log(stdBadges.err);
			console.log(stderr);
		}

		core.endGroup();
	}

	// PR comment (new behavior, requires access-token)
	const token = core.getInput("access-token");

	if (token && github.context.payload.pull_request) {
		await postPrComment(token, report, sortedActions);
	}
}

// --- PR Comment ---

const COMMENT_MARKER = "<!-- moon-ci-retrospect -->";
const MAIN_TABLE_LIMIT = 20;

const statusEmoji: Record<ActionStatus, string> = {
	passed: "🟢",
	cached: "🟣",
	"cached-from-remote": "🟣",
	failed: "🔴",
	"failed-and-abort": "🔴",
	aborted: "🟠",
	"timed-out": "🟠",
	invalid: "🟠",
	skipped: "⚪",
	running: "🔵",
};

const statusLabel: Record<ActionStatus, string> = {
	passed: "Passed",
	cached: "Cached",
	"cached-from-remote": "Cached (remote)",
	failed: "Failed",
	"failed-and-abort": "Failed",
	aborted: "Aborted",
	"timed-out": "Timed out",
	invalid: "Invalid",
	skipped: "Skipped",
	running: "Running",
};

function formatDuration(duration: { secs: number; nanos: number }): string {
	const totalMs = duration.secs * 1000 + duration.nanos / 1_000_000;

	if (totalMs < 1000) {
		return `${Math.round(totalMs)}ms`;
	}

	if (totalMs < 60_000) {
		return `${(totalMs / 1000).toFixed(1)}s`;
	}

	const mins = Math.floor(totalMs / 60_000);
	const secs = Math.round((totalMs % 60_000) / 1000);

	return `${mins}m ${secs}s`;
}

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function buildActionRow(action: Action): string {
	const emoji = statusEmoji[action.status];
	const label = statusLabel[action.status];
	const duration = action.duration ? formatDuration(action.duration) : "-";

	return `| ${emoji} ${label} | \`${action.label}\` | ${duration} |`;
}

function generateComment(report: RunReport, sortedActions: Action[]): string {
	const taskActions = sortedActions.filter((a) => a.node.action === "run-task");
	const failedCount = taskActions.filter((a) => failStatuses.has(a.status)).length;
	const passedCount = taskActions.filter((a) => a.status === "passed").length;
	const cachedCount = taskActions.filter((a) => a.status === "cached" || a.status === "cached-from-remote").length;
	const skippedCount = taskActions.filter((a) => a.status === "skipped").length;

	const { owner, repo } = github.context.repo;
	const sha = github.context.sha;
	const shortSha = sha.slice(0, 8);
	const commitUrl = `https://github.com/${owner}/${repo}/commit/${sha}`;

	const lines: string[] = [];

	lines.push(COMMENT_MARKER);
	lines.push(`### Run report for [${shortSha}](${commitUrl})`);
	lines.push("");

	// Summary line
	const totalDuration = formatDuration(report.duration);

	if (report.comparisonEstimate.gain) {
		const compDuration = formatDuration(report.comparisonEstimate.duration);
		const savings = formatDuration(report.comparisonEstimate.gain);
		const savingsPercent = report.comparisonEstimate.percent.toFixed(1);

		lines.push(`**Total time:** ${totalDuration} | **Comparison time:** ${compDuration} | **Estimated savings:** ${savings} (${savingsPercent}% faster)`);
	} else {
		lines.push(`**Total time:** ${totalDuration}`);
	}

	lines.push("");

	// Status summary
	const summaryParts: string[] = [];

	if (failedCount > 0) {
		summaryParts.push(`🔴 ${failedCount} failed`);
	}

	if (passedCount > 0) {
		summaryParts.push(`🟢 ${passedCount} passed`);
	}

	if (cachedCount > 0) {
		summaryParts.push(`🟣 ${cachedCount} cached`);
	}

	if (skippedCount > 0) {
		summaryParts.push(`⚪ ${skippedCount} skipped`);
	}

	if (summaryParts.length > 0) {
		lines.push(summaryParts.join(" · "));
		lines.push("");
	}

	// Failed tasks with error details (always shown prominently)
	const failedActions = taskActions.filter((a) => failStatuses.has(a.status));

	if (failedActions.length > 0) {
		lines.push("#### Failed Tasks");
		lines.push("");

		for (const action of failedActions) {
			const duration = action.duration ? formatDuration(action.duration) : "-";

			lines.push(`**${statusEmoji[action.status]} \`${action.label}\`** — ${statusLabel[action.status]} (${duration})`);

			if (action.error) {
				lines.push("");
				lines.push("```");
				lines.push(stripAnsi(action.error));
				lines.push("```");
			}

			lines.push("");
		}
	}

	// Main table (all actions, not just run-task)
	lines.push("| Status | Action | Time |");
	lines.push("|--------|--------|------|");

	const mainActions = sortedActions.slice(0, MAIN_TABLE_LIMIT);
	const remainingActions = sortedActions.slice(MAIN_TABLE_LIMIT);

	for (const action of mainActions) {
		lines.push(buildActionRow(action));
	}

	if (remainingActions.length > 0) {
		lines.push("");
		lines.push(`And ${remainingActions.length} more...`);
		lines.push("");
		lines.push("<details>");
		lines.push(`<summary>Expanded report (${remainingActions.length} actions)</summary>`);
		lines.push("");
		lines.push("| Status | Action | Time |");
		lines.push("|--------|--------|------|");

		for (const action of remainingActions) {
			lines.push(buildActionRow(action));
		}

		lines.push("");
		lines.push("</details>");
	}

	// Touched files
	const touchedFiles = report.context.touchedFiles;

	if (touchedFiles.length > 0) {
		lines.push("");
		lines.push("<details>");
		lines.push(`<summary>Touched files (${touchedFiles.length})</summary>`);
		lines.push("");

		for (const file of touchedFiles) {
			lines.push(`- \`${file}\``);
		}

		lines.push("");
		lines.push("</details>");
	}

	return lines.join("\n");
}

async function postPrComment(token: string, report: RunReport, sortedActions: Action[]): Promise<void> {
	const octokit = github.getOctokit(token);
	const { owner, repo } = github.context.repo;
	const prNumber = github.context.payload.pull_request?.number;

	if (!prNumber) {
		return;
	}

	const body = generateComment(report, sortedActions);

	// Find existing comment
	const { data: comments } = await octokit.rest.issues.listComments({
		owner,
		repo,
		issue_number: prNumber,
		per_page: 100,
	});

	const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

	if (existing) {
		await octokit.rest.issues.updateComment({
			owner,
			repo,
			comment_id: existing.id,
			body,
		});

		core.info(`Updated existing PR comment #${existing.id}`);
	} else {
		await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body,
		});

		core.info("Created new PR comment");
	}
}

// --- Utilities ---

interface TargetIdentity {
	task: (string & {}) | "unknown";
	project: (string & {}) | "unknown";
}

function parseTarget(target: string): TargetIdentity {
	const parts = target.split(":");

	const project = parts[0] ?? "unknown";
	const task = parts[1] ?? "unknown";

	return { project, task };
}

function commandOf(action: Action): OperationMetaTaskExecution["command"] {
	for (const operation of action.operations) {
		if (operation.meta.type === "task-execution") {
			return operation.meta.command;
		}
	}

	return undefined;
}

async function readStatus(
	workspaceRoot: string,
	{ project, task }: TargetIdentity,
): Promise<{ stdout: string; stderr: string }> {
	const statusDir = `${workspaceRoot}/.moon/cache/states/${project}/${task}`;

	const stdoutPath = `${statusDir}/stdout.log`;
	const stderrPath = `${statusDir}/stderr.log`;

	const stdout = (await fileExists(stdoutPath)) ? await readFile(stdoutPath, { encoding: "utf8" }) : "";

	const stderr = (await fileExists(stderrPath)) ? await readFile(stderrPath, { encoding: "utf8" }) : "";

	return { stdout, stderr };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);

		return true;
	} catch {
		return false;
	}
}

// --- ANSI formatting (workflow logs) ---

const statusBadges: Record<ActionStatus, string> = {
	running: bgGreen(" RUNNING "),
	passed: bgGreen(" PASS "),

	failed: bgRed(" FAIL "),
	"timed-out": bgRed(" TIMED OUT "),
	aborted: bgRed(" ABORTED "),
	invalid: bgRed(" INVALID "),
	"failed-and-abort": bgRed(" FAILED AND ABORT "),

	skipped: bgBlue(" SKIP "),
	cached: bgBlue(" CACHED "),
	"cached-from-remote": bgBlue(" REMOTE CACHED "),
};

function bgGreen(text: string): string {
	return `\u001b[42m${text}\u001b[49m`;
}

function bgRed(text: string): string {
	return `\u001b[41m${text}\u001b[49m`;
}

function bgBlue(text: string): string {
	return `\u001b[44m${text}\u001b[49m`;
}

function bgDarkGray(text: string): string {
	return `\u001b[48;5;236m${text}\u001b[49m`;
}

function bold(text: string): string {
	return `\u001b[1m${text}\u001b[22m`;
}

function green(text: string): string {
	return `\u001b[32m${text}\u001b[39m`;
}

function red(text: string): string {
	return `\u001b[31m${text}\u001b[39m`;
}

function blue(text: string): string {
	return `\u001b[34m${text}\u001b[39m`;
}

const stdBadges = {
	out: bgDarkGray(`　${green("⏺")} STDOUT　`),
	err: bgDarkGray(`　${red("⏺")} STDERR　`),
} as const;

try {
	await main();
} catch (error) {
	console.error(error);
	process.exit(0);
}
