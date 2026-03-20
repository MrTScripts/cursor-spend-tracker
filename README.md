# Cursor Spend Tracker

[![CI](https://img.shields.io/github/actions/workflow/status/maurice2k/cursor-spend-tracker/ci.yml?branch=main&style=flat-square)](https://github.com/maurice2k/cursor-spend-tracker/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Cursor](https://img.shields.io/badge/Cursor-Extension-141414?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/)

A [Cursor](https://cursor.com/) extension that shows your on-demand spend in the status bar (not useful with plain VS Code).

## Features

- 💰 **Real-time Spending Display** - See your Cursor on-demand costs right in the status bar
- 📊 **Daily Statistics** - View today's, yesterday's, and last 2 hours usage in the tooltip
- ⚡ **Included Quota Tracking** - Monitor your included request quota usage
- 🔔 **Alerts for Expensive Requests** - Visual alerts when you make expensive requests (configurable threshold, default: >$2)
- 🔄 **Auto-refresh** - Configurable refresh interval (default: 5 minutes)
- 🔧 **Manual Session Cookie** - Set session cookie manually if automatic detection fails

## Installation

Install **in Cursor** (not VS Code). Get a `.vsix` from the [releases page](https://github.com/maurice2k/cursor-spend-tracker/releases) or build one locally (`npm run compile` then `npx @vscode/vsce package`).

### Option A — Command Palette

1. **⌘⇧P** (macOS) or **Ctrl+Shift+P** (Windows/Linux)
2. Run **`Extensions: Install from VSIX...`**
3. Choose your `.vsix` file

Tip: in the palette, typing `vsix` is enough to surface the command.

### Option B — Terminal

With Cursor’s **`cursor`** CLI on your PATH (install from Cursor: **⌘⇧P** → `Shell Command: Install 'cursor' command in PATH`):

```bash
cursor --install-extension /absolute/path/to/extension.vsix
```

Use **`--force`** to replace an already-installed copy of the same extension.

After install, use **⌘⇧P** → **Developer: Reload Window** if the extension does not activate immediately.

## Usage

After installation, the extension automatically shows your current spend in the status bar:

- **💳 `$X.XX`** - Shows on-demand spending
- **⚡ `X/Y`** - Shows included quota usage when no on-demand spend
- **🔥 `$X.XX`** - Alert mode for recently expensive requests

### Commands

| Command | Description |
|--------|-------------|
| `Cursor Spend: Refresh Now` | Manually refresh the usage data |
| `Cursor Spend: Open Dashboard` | Open the Cursor usage dashboard |
| `Cursor Spend: Set Session Cookie` | Manually set the WorkosCursorSessionToken cookie (useful if automatic detection fails) |

### Setting Session Cookie Manually

If the extension cannot read the session token from Cursor's local database, you can set it manually:

1. Open Command Palette (**⌘⇧P** / **Ctrl+Shift+P**)
2. Run "Cursor Spend: Set Session Cookie"
3. Paste either:
   - **Cookie pair**: `WorkosCursorSessionToken=<value>`
   - **Value only**: `<value>` (e.g. `user_…::eyJ…`)
   - **Full curl command**: from DevTools → Network → request → Copy as cURL

The extension parses the token from any of these. Values copied URL-encoded from DevTools are normalized so they are not double-encoded when sent.

To get the curl command:
1. Open Cursor in your browser (https://cursor.com)
2. Log in and navigate to the Dashboard
3. Open Developer Tools (F12)
4. Go to the Network tab
5. Refresh the page or make a request
6. Find a request to `cursor.com` and right-click → Copy → Copy as cURL

### Configuration

| Setting | Default | Description |
|--------|---------|-------------|
| `cursorSpendTracker.refreshIntervalSeconds` | `300` | How often to refresh usage data (in seconds) |
| `cursorSpendTracker.costlyRequestThreshold` | `2.0` | Threshold in USD for costly request alerts and tracking |
| `cursorSpendTracker.sessionCookie` | *empty* | Manual session cookie (WorkosCursorSessionToken). Leave empty to auto-detect from Cursor. |

## Preview

![Extension Preview](images/preview.png)

## Tooltip

The status bar tooltip displays detailed usage information:

| Column | Description |
|--------|-------------|
| **Spend** | Your on-demand usage and remaining balance |
| **Included** | Your included request quota |
| **Today** | Number of requests, total cost, and average cost per request for today |
| **Yesterday** | Same metrics for yesterday |
| **Last 2h** | Spending statistics for the last 2 hours |

## Requirements

- [Cursor](https://cursor.com/) (extension checks the host; it will not run in VS Code)
- Cursor/VS Code engine version per `package.json` `engines.vscode` (for API compatibility)
- Node.js (only for building from source)
- `sqlite3` CLI (optional fallback: reads `cursorAuth/accessToken` from Cursor’s `state.vscdb` when no manual cookie is set)

## Development

### Prerequisites

- Node.js 18+ and npm
- `sqlite3` CLI (optional, for auto-detecting the session token from Cursor's local DB)

### Setup

```bash
# Install dependencies
npm install

# Compile the extension
npm run compile

# Watch mode (auto-compile on changes)
npm run watch
```

### Packaging

```bash
npm run compile
npx @vscode/vsce package
# → cursor-spend-tracker-<version>.vsix in the repo root; install in Cursor via steps above
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request


## License

MIT License - see [LICENSE](LICENSE) file for details.

*Cursor is a registered trademark of Anysphere, Inc. This extension is not affiliated with, sponsored, or endorsed by Anysphere, Inc.*
