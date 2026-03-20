import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';

// ====== Cookie Parsing Helpers ======

/**
 * Extract WorkosCursorSessionToken from a cookie string or curl -b header
 */
function extractSessionCookie(input: string): string | null {
  // Try to extract from cookie header format: "key1=value1; key2=value2; ..."
  const cookieMatch = input.match(/WorkosCursorSessionToken=([^;]+)/);
  if (cookieMatch) {
    return cookieMatch[1];
  }

  // Try to extract from curl -b format (same structure)
  // The -b flag can have the cookies as a string
  return null;
}

/**
 * Try to extract session cookie from a curl command string
 * Looks for patterns like: -b 'cookie_string' or --cookie 'cookie_string'
 */
function extractCookieFromCurl(input: string): string | null {
  // Match -b '...' or --cookie '...'
  const curlCookieMatch = input.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/);
  if (curlCookieMatch) {
    const cookies = curlCookieMatch[1];
    const sessionMatch = cookies.match(/WorkosCursorSessionToken=([^;]+)/);
    if (sessionMatch) {
      return sessionMatch[1];
    }
  }
  return null;
}

/** Paste is only the value: user_xxx::jwt or user_xxx%3A%3Ajwt (no cookie name) */
function extractBareSessionValue(input: string): string | null {
  const t = input.trim();
  if (!t || /WorkosCursorSessionToken\s*=/i.test(t)) {
    return null;
  }
  if (/^user_[a-zA-Z0-9_]+(::|%3A%3A).+/.test(t)) {
    return t;
  }
  return null;
}

/**
 * DevTools often shows URL-encoded cookie values (%3A%3A for ::). Encoding again breaks the session.
 */
function normalizeSessionTokenForStorage(raw: string): string {
  const t = raw.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(t)) {
    return t;
  }
  try {
    const d = decodeURIComponent(t);
    if (d.startsWith('user_') && d.includes('::')) {
      return d;
    }
  } catch {
    /* keep raw */
  }
  return t;
}

interface UsageEvent {
  timestamp: string;
  model: string;
  kind: string;
  requestsCosts: number;
  chargedCents: number;
  tokenUsage?: { totalCents?: number };
}

interface DayStat { reqs: number; cents: number; }

interface UsageData {
  onDemandUsed: number;
  onDemandLimit: number;
  onDemandRemaining: number;
  includedUsed: number;
  includedTotal: number;
  events: UsageEvent[];
  fetchedAt: number;
  numericUserId?: number;
}

function getStateDbPath(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

async function readSessionTokenFromDb(context: vscode.ExtensionContext): Promise<string | null> {
  // First check if user manually set a session cookie
  const manualCookie = context.globalState.get<string>('sessionCookie', '');
  if (manualCookie) {
    return manualCookie;
  }

  // Fall back to reading from Cursor's local database
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);
  try {
    const dbPath = getStateDbPath();
    const { stdout } = await exec('sqlite3', [dbPath, 'SELECT value FROM ItemTable WHERE key = "cursorAuth/accessToken"']);
    const jwt = stdout.trim();
    if (!jwt) { return null; }
    const payload = jwt.split('.')[1];
    const padded = payload + '=='.slice((payload.length % 4) || 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const userId = (decoded.sub as string).split('|')[1];
    if (!userId) { return null; }
    return `${userId}::${jwt}`;
  } catch {
    return null;
  }
}

/**
 * Prompt user to paste session cookie or curl command and extract the token.
 * Returns true if a token was saved.
 */
async function setSessionCookie(context: vscode.ExtensionContext): Promise<boolean> {
  const input = await vscode.window.showInputBox({
    prompt: 'Paste WorkosCursorSessionToken value, full cookie, or curl -b',
    placeHolder: 'user_…::eyJ… or WorkosCursorSessionToken=user_…',
    password: false
  });

  if (!input) {
    return false;
  }

  let token: string | null =
    extractSessionCookie(input) ??
    extractCookieFromCurl(input) ??
    extractBareSessionValue(input);

  if (token) {
    token = normalizeSessionTokenForStorage(token);
    await context.globalState.update('sessionCookie', token);
    await vscode.window.showInformationMessage(
      'Cursor Spend: session cookie saved. Refreshing usage…'
    );
    return true;
  }

  await vscode.window.showErrorMessage(
    'Cursor Spend: could not parse input. Use WorkosCursorSessionToken=… or paste the raw user_…::… value.'
  );
  return false;
}

function httpsPost(url: string, token: string, body: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
      headers: {
        'accept': '*/*', 'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'origin': 'https://cursor.com',
        'referer': 'https://cursor.com/dashboard?tab=usage',
        'cookie': `WorkosCursorSessionToken=${encodeURIComponent(token)}`,
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => res.statusCode && res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function httpsGet(url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'accept': '*/*', 'referer': 'https://cursor.com/dashboard?tab=usage',
        'cookie': `WorkosCursorSessionToken=${encodeURIComponent(token)}`,
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => res.statusCode && res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchUsage(token: string): Promise<UsageData> {
  const [summaryBody, usageBody, eventsBody, meBody] = await Promise.all([
    httpsGet('https://cursor.com/api/usage-summary', token),
    httpsGet('https://cursor.com/api/usage', token),
    httpsPost('https://cursor.com/api/dashboard/get-filtered-usage-events', token, {
      startMs: 0, endMs: Date.now(), page: 1, pageSize: 500
    }),
    httpsGet('https://cursor.com/api/auth/me', token),
  ]);

  const summary = JSON.parse(summaryBody);
  const usageData = JSON.parse(usageBody);
  const eventsData = JSON.parse(eventsBody);
  const me = JSON.parse(meBody);

  const individual = summary?.individualUsage?.overall ?? summary?.individualUsage?.onDemand ?? {};
  let includedUsed = 0, includedTotal = 0;
  for (const model of Object.values(usageData) as { numRequests?: number; maxRequestUsage?: number | null }[]) {
    if (model && typeof model === 'object' && 'numRequests' in model) {
      includedUsed += model.numRequests ?? 0;
      if ((model.maxRequestUsage ?? 0) > includedTotal) { includedTotal = model.maxRequestUsage ?? 0; }
    }
  }
  includedUsed = Math.min(includedUsed, includedTotal);

  const events: UsageEvent[] = (eventsData.usageEventsDisplay ?? []).map((e: Record<string, unknown>) => ({
    timestamp: e.timestamp as string,
    model: (e.model as string) ?? 'unknown',
    kind: (e.kind as string) ?? '',
    requestsCosts: (e.requestsCosts as number) ?? 0,
    chargedCents: (e.chargedCents as number) ?? 0,
    tokenUsage: e.tokenUsage as { totalCents?: number } | undefined,
  }));

  return {
    onDemandUsed: individual.used ?? 0,
    onDemandLimit: individual.limit ?? 0,
    onDemandRemaining: individual.remaining ?? 0,
    includedUsed, includedTotal, events,
    fetchedAt: Date.now(),
    numericUserId: me?.id,
  };
}

function fmtDollars(cents: number, decimals = 2): string {
  return `$${(cents / 100).toFixed(decimals)}`;
}

function startOfDayMs(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function aggregateDay(events: UsageEvent[], startMs: number, endMs: number): DayStat {
  let reqs = 0, cents = 0;
  for (const e of events) {
    const ts = parseInt(e.timestamp);
    if (ts >= startMs && ts < endMs) {
      reqs++;
      cents += e.chargedCents;
    }
  }
  return { reqs, cents };
}

export function activate(context: vscode.ExtensionContext) {
  if (!vscode.env.appName.toLowerCase().includes('cursor')) {
    vscode.window.showWarningMessage('Cursor Spend Tracker only works in Cursor, not VS Code.');
    return;
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cursorSpendTracker.openDashboard';
  statusBar.tooltip = 'Cursor spend — click to open dashboard';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const CACHE_KEY = 'cachedUsageData';
  let lastData: UsageData | null = context.globalState.get<UsageData>(CACHE_KEY) ?? null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alertTimer: ReturnType<typeof setInterval> | undefined;
  let blinkTimer: ReturnType<typeof setInterval> | undefined;
  let wasAlerting = false;

  function getCostlyRequestThresholdCents(): number {
    return Math.round((vscode.workspace.getConfiguration('cursorSpendTracker').get<number>('costlyRequestThreshold') ?? 2.0) * 100);
  }

  function hasRecentExpensiveRequest(events: UsageEvent[] | undefined): boolean {
    if (!events) { return false; }
    const cutoff = Date.now() - 20 * 60 * 1000;
    const threshold = getCostlyRequestThresholdCents();
    for (const e of events) {
      const ts = parseInt(e.timestamp);
      if (ts >= cutoff && e.chargedCents >= threshold) {
        return true;
      }
    }
    return false;
  }

  function startBlink() {
    if (blinkTimer) { clearInterval(blinkTimer); }
    let count = 0;
    const errorBg = new vscode.ThemeColor('statusBarItem.errorBackground');
    const errorFg = new vscode.ThemeColor('statusBarItem.errorForeground');
    blinkTimer = setInterval(() => {
      count++;
      const on = count % 2 === 0;
      statusBar.backgroundColor = on ? errorBg : undefined;
      statusBar.color = on ? errorFg : undefined;
      if (count >= 10) {
        clearInterval(blinkTimer!);
        blinkTimer = undefined;
        statusBar.backgroundColor = errorBg;
        statusBar.color = errorFg;
      }
    }, 500);
  }

  function stopBlink() {
    if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = undefined; }
  }

  function updateStatusBar(data: UsageData) {
    const incPct = data.includedTotal > 0 ? data.includedUsed / data.includedTotal : 0;
    const alert = hasRecentExpensiveRequest(data.events);

    if (alert) {
      statusBar.text = `$(flame) ${fmtDollars(data.onDemandUsed)}`;
      statusBar.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      if (!wasAlerting) { startBlink(); }
      wasAlerting = true;
    } else if (data.includedTotal === 0 || data.onDemandUsed > 0) {
      stopBlink(); wasAlerting = false;
      statusBar.color = undefined;
      statusBar.text = `$(credit-card) ${fmtDollars(data.onDemandUsed)}`;
      statusBar.backgroundColor = undefined;
    } else if (incPct < 1) {
      stopBlink(); wasAlerting = false;
      statusBar.color = undefined;
      statusBar.text = `$(zap) ${data.includedUsed}/${data.includedTotal}`;
      statusBar.backgroundColor = undefined;
    } else {
      stopBlink(); wasAlerting = false;
      statusBar.color = undefined;
      statusBar.text = `$(error) ${data.includedUsed}/${data.includedTotal}`;
      statusBar.backgroundColor = undefined;
    }

    // Daily stats
    const todayStart = startOfDayMs(0);
    const yesterdayStart = startOfDayMs(1);
    const evts = data.events ?? [];
    const today = aggregateDay(evts, todayStart, Date.now());
    const yesterday = aggregateDay(evts, yesterdayStart, todayStart);

    const fmtRow = (label: string, s: DayStat) => {
      if (s.reqs === 0) { return `| ${label} | — | — | — |`; }
      const cpr = s.cents / s.reqs;
      return `| ${label} | ${s.reqs} | ${fmtDollars(s.cents)} | ${fmtDollars(cpr)} |`;
    };

    // Last 2h stats
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    let last2hReqs = 0, last2hCents = 0;
    const expensiveEvents: { model: string; cents: number }[] = [];
    const thresholdCents = getCostlyRequestThresholdCents();
    for (const e of evts) {
      const ts = parseInt(e.timestamp);
      if (ts >= twoHoursAgo) {
        last2hReqs++;
        last2hCents += e.chargedCents;
        if (e.chargedCents >= thresholdCents) {
          expensiveEvents.push({ model: e.model, cents: e.chargedCents });
        }
      }
    }
    const last2h: DayStat = { reqs: last2hReqs, cents: last2hCents };

    expensiveEvents.sort((a, b) => b.cents - a.cents);
    const topExpensive = expensiveEvents.slice(0, 5);
    let expensiveRows = '';
    if (topExpensive.length > 0) {
      const thresholdDollars = (thresholdCents / 100).toFixed(2).replace(/\.00$/, '');
      expensiveRows = `\n\n**Top costly requests (2h, >$${thresholdDollars})**\n\n` +
        `| Model | Cost |\n|---|---|\n` +
        topExpensive.map(e => `| ${e.model} | ${fmtDollars(e.cents)} |`).join('\n');
    }

    const includedRow = data.includedTotal > 0
      ? `| ⚡ Included | ${data.includedUsed} / ${data.includedTotal} |\n` : '';

    const version = vscode.extensions.getExtension('maurice2k.cursor-spend-tracker')?.packageJSON?.version ?? '?';
    const tooltip = new vscode.MarkdownString(
      `**Cursor Spend Tracker** <span style="color:#888;font-size:10px;">v${version}</span>\n\n` +
      `| | |\n|---|---|\n` +
      `| 💳 Spend | ${fmtDollars(data.onDemandUsed)} / ${fmtDollars(data.onDemandLimit, 0)} |\n` +
      `| &nbsp;&nbsp;Remaining | ${fmtDollars(data.onDemandRemaining)} |\n` +
      includedRow + `\n` +
      `**Spend**\n\n` +
      `| | Reqs | Cost | $/req |\n|---|---|---|---|\n` +
      fmtRow('Today', today) + '\n' +
      fmtRow('Yesterday', yesterday) + '\n' +
      `| | | | |\n` +
      fmtRow('Last 2h', last2h) +
      expensiveRows + `\n\n` +
      `_Click to open dashboard_`
    );
    tooltip.supportHtml = true;
    statusBar.tooltip = tooltip;
  }

  function startAlertChecker() {
    if (alertTimer) { clearInterval(alertTimer); }
    alertTimer = setInterval(() => {
      if (lastData) { updateStatusBar(lastData); }
    }, 60_000);
  }

  async function refresh() {
    const token = await readSessionTokenFromDb(context);
    if (!token) {
      statusBar.text = '$(credit-card) Cursor: not logged in';
      statusBar.tooltip = 'Could not read auth token from Cursor — are you logged in?';
      return;
    }
    try {
      const data = await fetchUsage(token);
      lastData = data;
      await context.globalState.update(CACHE_KEY, data);
      updateStatusBar(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      statusBar.text = '$(error) Cursor $?';
      statusBar.tooltip = `Cursor Spend: ${msg}`;
    }
  }

  function scheduleRefresh() {
    if (timer) { clearTimeout(timer); }
    const intervalMs = (vscode.workspace.getConfiguration('cursorSpendTracker').get<number>('refreshIntervalSeconds') ?? 300) * 1000;
    timer = setTimeout(async () => { await refresh(); scheduleRefresh(); }, intervalMs);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorSpendTracker.refresh', async () => {
      statusBar.text = '$(loading~spin) Cursor $…';
      await refresh();
      scheduleRefresh();
    }),
    vscode.commands.registerCommand('cursorSpendTracker.openDashboard', () => {
      const uid = lastData?.numericUserId;
      const url = uid
        ? `https://cursor.com/dashboard?tab=usage&user=${uid}`
        : 'https://cursor.com/dashboard?tab=usage';
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('cursorSpendTracker.setSessionCookie', async () => {
      const ok = await setSessionCookie(context);
      if (ok) {
        statusBar.text = '$(loading~spin) Cursor $…';
        await refresh();
        scheduleRefresh();
      }
    }),
  );

  if (lastData) {
    updateStatusBar(lastData);
  } else {
    statusBar.text = '$(loading~spin) Cursor $…';
  }

  startAlertChecker();
  refresh().then(() => scheduleRefresh());
}

export function deactivate() {}
