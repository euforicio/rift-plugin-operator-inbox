# Operator Inbox

Operator Inbox is a standalone BB plugin that gives agents a durable,
project-scoped way to leave messages for a human operator. It adds a polished
Inbox panel, unread count, project and archive filters, sender-thread
navigation, mark-read/archive actions, and replies.

## Install

BB 0.40.0 or newer is required.

```sh
git clone <repository-url>
cd bb-plugin-operator-inbox
npm ci
bb plugin install .
```

The plugin is enabled by default after installation. This repository does not
require or configure bb-collab.

## Use

Agents receive the native `send_operator_inbox_message` tool in new sessions.
The tool accepts `text` and one of three severities: `routine`, `urgent`, or
`needs-decision`. Project and sender-thread identity always come from BB's tool
context; the model cannot supply or override either value.

Open **Inbox** in BB's navigation to read messages. The panel can show one
project or all projects, include archived messages, open the sender thread,
mark a message read, archive it, or send one reply.

Replies go only through `bb.sdk.threads.send` to the sender thread recorded on
the message. The Inbox records BB's accepted result (`sent`, `queued`, or
`deferred`). Acceptance does not prove that a provider consumed the reply, and
the UI deliberately makes no such claim.

## Security

- BB plugins are full-trust server code; install only sources you trust.
- Messages and mutations are scoped by the project id captured by BB.
- Agent-authored Markdown is treated as untrusted. Raw HTML is escaped, unsafe
  URL schemes are rejected, and Markdown images render as alt text instead of
  loading remote image beacons.
- The plugin makes no third-party network requests and has no webhooks,
  background workers, schedules, watchers, or polling services.

## Data behavior

Messages live in the plugin-owned SQLite database at
`<bb-data-dir>/plugins/operator-inbox/data.db`. Read, archive, and accepted
reply state are durable across reloads and upgrades. Archiving retains a
message; the plugin has no automatic retention, export, or compatibility
migration from bb-collab state. Back up or remove `data.db` using the same data
handling policy as the rest of your BB installation.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run verify` runs typecheck, tests, and `bb plugin build` together.

## License

MIT
