#!/usr/bin/env npx tsx
// harvest-cli — Harvest API v2 CLI for omni time-reporting
// Auth: ~/.omni/secrets.json { HARVEST_TOKEN, HARVEST_ACCOUNT_ID }

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Types
interface Secrets { HARVEST_TOKEN: string; HARVEST_ACCOUNT_ID: string }
interface HarvestUser { id: number; first_name: string; last_name: string; email: string; timezone: string }
interface TaskAssignment { id: number; task: { id: number; name: string }; billable: boolean }
interface ProjectAssignment {
  id: number;
  project: { id: number; name: string; code: string };
  client: { id: number; name: string };
  task_assignments: TaskAssignment[];
}
interface TimeEntry {
  id: number; spent_date: string; hours: number; notes: string | null;
  project: { id: number; name: string }; client: { id: number; name: string };
  task: { id: number; name: string }; user: { id: number; name: string };
}
interface CachedProjects { fetched_at: number; assignments: ProjectAssignment[] }

// Auth
function loadSecrets(): Secrets {
  const p = path.join(os.homedir(), ".omni", "secrets.json");
  if (!fs.existsSync(p)) die(`secrets file not found at ${p}`);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw.HARVEST_TOKEN || !raw.HARVEST_ACCOUNT_ID)
      die("HARVEST_TOKEN and HARVEST_ACCOUNT_ID must be set in ~/.omni/secrets.json");
    return raw as Secrets;
  } catch (e) { die(`failed to parse ${p}: ${e}`); }
}

// HTTP
function request<T>(method: string, urlPath: string, secrets: Secrets, body?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: "api.harvestapp.com",
      path: `/api/v2${urlPath}`,
      method,
      headers: {
        Authorization: `Bearer ${secrets.HARVEST_TOKEN}`,
        "Harvest-Account-Id": secrets.HARVEST_ACCOUNT_ID,
        "User-Agent": "omni-harvest-cli",
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}: ${text.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(text) as T); }
        catch { reject(new Error(`Failed to parse response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAll<T>(urlPath: string, key: string, secrets: Secrets): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = urlPath.includes("?") ? "&" : "?";
    const data = await request<Record<string, unknown>>("GET", `${urlPath}${sep}page=${page}&per_page=100`, secrets);
    const items = (data[key] as T[]) ?? [];
    results.push(...items);
    if (!(data.next_page as number | null)) break;
    page++;
  }
  return results;
}

// Project cache
const CACHE_PATH = "/tmp/harvest-projects.json";
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getProjects(secrets: Secrets): Promise<ProjectAssignment[]> {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      const cached: CachedProjects = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached.assignments;
    } catch { /* stale cache */ }
  }
  const assignments = await getAll<ProjectAssignment>("/users/me/project_assignments.json", "project_assignments", secrets);
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetched_at: Date.now(), assignments }, null, 2));
  return assignments;
}

// Date helpers (Stockholm timezone)
function currentWeekBounds(): { from: string; to: string } {
  const now = new Date();
  const str = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const [y, m, d] = str.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const dow = day.getDay() || 7;
  const mon = new Date(day); mon.setDate(day.getDate() - dow + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

function weekBounds(isoWeek: string): { from: string; to: string } {
  const [yearStr, weekStr] = isoWeek.split("-W");
  const year = parseInt(yearStr, 10), week = parseInt(weekStr, 10);
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

// Fuzzy matching
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase(), t = target.toLowerCase();
  if (t === q) return 100;
  if (t.includes(q)) return 80 - t.indexOf(q);
  const words = t.split(/[\s|/._-]+/);
  if (words.map((w) => w[0] ?? "").join("").startsWith(q)) return 70;
  if (words.some((w) => w.startsWith(q))) return 60;
  return Math.max(0, 40 - levenshtein(q, t.slice(0, Math.max(q.length, 1))) * 10);
}

// Output
function die(msg: string): never { console.error(`error: ${msg}`); process.exit(1); }
function col(s: string, w: number): string { return s.length >= w ? s.slice(0, w - 1) + "…" : s.padEnd(w); }
function fmtH(h: number): string { return h.toFixed(2); }

// Commands
async function cmdMe(s: Secrets): Promise<void> {
  const u = await request<HarvestUser>("GET", "/users/me.json", s);
  console.log(`Name:     ${u.first_name} ${u.last_name}\nEmail:    ${u.email}\nTimezone: ${u.timezone}\nUser ID:  ${u.id}`);
}

async function cmdProjects(s: Secrets): Promise<void> {
  const assignments = await getProjects(s);
  if (!assignments.length) { console.log("(no projects)"); return; }
  for (const a of assignments) {
    console.log(`${a.client.name} | ${a.project.name} (project_id: ${a.project.id})`);
    for (const ta of a.task_assignments)
      console.log(`    task_id: ${ta.task.id}  ${ta.task.name}`);
  }
}

async function cmdList(s: Secrets, args: string[]): Promise<void> {
  let from: string | undefined, to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i+1]) from = args[++i];
    else if (args[i] === "--to" && args[i+1]) to = args[++i];
    else if (args[i] === "--week" && args[i+1]) { const b = weekBounds(args[++i]); from = b.from; to = b.to; }
    else if (args[i] === "--month" && args[i+1]) { const b = monthBounds(args[++i]); from = b.from; to = b.to; }
  }
  if (!from || !to) { const b = currentWeekBounds(); from = b.from; to = b.to; }

  console.log(`Period: ${from} to ${to}\n`);
  const u = await request<HarvestUser>("GET", "/users/me.json", s);
  const entries = await getAll<TimeEntry>(`/time_entries?user_id=${u.id}&from=${from}&to=${to}`, "time_entries", s);
  if (!entries.length) { console.log("(no entries)"); return; }

  const byProject = new Map<string, { label: string; hours: number; entries: TimeEntry[] }>();
  for (const e of entries) {
    const key = String(e.project.id);
    if (!byProject.has(key)) byProject.set(key, { label: `${e.client.name} | ${e.project.name}`, hours: 0, entries: [] });
    const g = byProject.get(key)!;
    g.hours += e.hours; g.entries.push(e);
  }

  const [WD, WT, WN, WH] = [12, 22, 30, 6];
  const line = "-".repeat(WD + WT + WN + WH + 6);
  let grand = 0;

  for (const [, g] of byProject) {
    console.log(`\n${g.label}`);
    console.log(line);
    console.log(`${col("Date", WD)}  ${col("Task", WT)}  ${col("Notes", WN)}  ${col("Hrs", WH)}`);
    console.log(line);
    g.entries.sort((a, b) => a.spent_date.localeCompare(b.spent_date));
    for (const e of g.entries)
      console.log(`${col(e.spent_date, WD)}  ${col(e.task.name, WT)}  ${col(e.notes ?? "", WN)}  ${fmtH(e.hours).padStart(WH)}`);
    console.log(line);
    console.log(`${"".padEnd(WD + WT + WN + 4)}  ${"Total:".padStart(WH - 1)} ${fmtH(g.hours)}`);
    grand += g.hours;
  }
  console.log(`\nGrand total: ${fmtH(grand)} hours`);
}

async function cmdAdd(s: Secrets, args: string[]): Promise<void> {
  let projectId: string | undefined, taskId: string | undefined, date: string | undefined;
  let hours: number | undefined, notes: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-id" && args[i+1]) projectId = args[++i];
    else if (args[i] === "--task-id" && args[i+1]) taskId = args[++i];
    else if (args[i] === "--date" && args[i+1]) date = args[++i];
    else if (args[i] === "--hours" && args[i+1]) hours = parseFloat(args[++i]);
    else if (args[i] === "--notes" && args[i+1]) notes = args[++i];
  }
  if (!projectId) die("--project-id is required");
  if (!taskId) die("--task-id is required");
  if (!date) die("--date is required (YYYY-MM-DD)");
  if (hours === undefined || isNaN(hours)) die("--hours is required");

  const body: Record<string, unknown> = { project_id: parseInt(projectId, 10), task_id: parseInt(taskId, 10), spent_date: date, hours };
  if (notes) body.notes = notes;
  const e = await request<TimeEntry>("POST", "/time_entries", s, body);
  console.log(`Created time entry #${e.id}`);
  console.log(`  Date:    ${e.spent_date}\n  Project: ${e.client.name} | ${e.project.name}\n  Task:    ${e.task.name}\n  Hours:   ${fmtH(e.hours)}`);
  if (e.notes) console.log(`  Notes:   ${e.notes}`);
}

async function cmdMatchProject(s: Secrets, args: string[]): Promise<void> {
  const query = args.join(" ").trim();
  if (!query) die("provide a search query");
  const assignments = await getProjects(s);
  const scored = assignments
    .map((a) => {
      const label = `${a.client.name} | ${a.project.name}`;
      const score = Math.max(fuzzyScore(query, a.client.name), fuzzyScore(query, a.project.name), fuzzyScore(query, a.project.code ?? ""), fuzzyScore(query, label));
      return { a, score, label };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 5)
    .filter((x) => x.score > 25);

  if (!scored.length) { console.log("(no matches)"); return; }
  for (const { a, label, score } of scored) {
    console.log(`\n${label}\n  project_id: ${a.project.id}  (score: ${score})\n  tasks:`);
    for (const ta of a.task_assignments)
      console.log(`    task_id: ${ta.task.id}  ${ta.task.name}`);
  }
}

async function cmdMatchTask(s: Secrets, args: string[]): Promise<void> {
  let projectId: string | undefined;
  const qParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-id" && args[i+1]) projectId = args[++i];
    else qParts.push(args[i]);
  }
  if (!projectId) die("--project-id is required");
  const query = qParts.join(" ").trim();
  if (!query) die("provide a search query");
  const assignments = await getProjects(s);
  const assignment = assignments.find((a) => String(a.project.id) === projectId);
  if (!assignment) die(`project_id ${projectId} not found in your assignments`);

  const top = assignment.task_assignments
    .map((ta) => ({ ta, score: fuzzyScore(query, ta.task.name) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .filter((x) => x.score > 0);

  if (!top.length) { console.log("(no matches)"); return; }
  for (const { ta, score } of top)
    console.log(`task_id: ${ta.task.id}  ${ta.task.name}  (score: ${score})`);
}

// Main
async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`harvest-cli <command> [options]

Commands:
  me                        Print current user info
  projects                  List all project assignments with tasks
  list [options]            List time entries (default: current week)
    --from YYYY-MM-DD
    --to   YYYY-MM-DD
    --week YYYY-Www         e.g. 2026-W14
    --month YYYY-MM         e.g. 2026-04
  add --project-id ID --task-id ID --date YYYY-MM-DD --hours N [--notes "..."]
  match-project QUERY       Fuzzy-find a project by name/client/code
  match-task --project-id ID QUERY  Fuzzy-find a task within a project
`);
    return;
  }

  const secrets = loadSecrets();
  try {
    switch (cmd) {
      case "me":            await cmdMe(secrets); break;
      case "projects":      await cmdProjects(secrets); break;
      case "list":          await cmdList(secrets, rest); break;
      case "add":           await cmdAdd(secrets, rest); break;
      case "match-project": await cmdMatchProject(secrets, rest); break;
      case "match-task":    await cmdMatchTask(secrets, rest); break;
      default: die(`unknown command: ${cmd}. Run harvest-cli --help`);
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

main();
