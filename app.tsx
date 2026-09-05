import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon, ArrowClockwiseIcon, CaretDownIcon, FileIcon, FileTextIcon, FilePdfIcon, ImageIcon, GlobeIcon, GithubLogoIcon, EnvelopeOpenIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { definePluginApp, UrlLink, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalLiveFileTarget, PluginNavPanelProps, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { fileContextSchema, safeAbsolutePath, type rpcContract } from "./contract";

const INBOX_CHANGED_CHANNEL = "messages-changed";
type FileContext = PluginRpcResult<typeof rpcContract["messageFileContext"]>;

function localTarget(href: string, context: FileContext): ExperimentalLiveFileTarget | null {
  if (!context) return null;
  let path: string;
  try { path = decodeURIComponent(href); } catch { return null; }
  if (!safeAbsolutePath(path)) return null;
  if (path.startsWith(`${context.storageRootPath}/`)) {
    return { kind: "thread-storage", threadId: context.threadId, path: path.slice(context.storageRootPath.length + 1) };
  }
  if (context.workspacePath && path.startsWith(`${context.workspacePath}/`)) {
    return { kind: "workspace", environmentId: context.environmentId, path: path.slice(context.workspacePath.length + 1) };
  }
  return { kind: "host", hostId: context.hostId, path };
}

function MessageBody({ text, message }: { text: string; message?: OperatorMessage }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [openError, setOpenError] = useState(false);
  const [context, setContext] = useState<FileContext>(null);
  const projectId = message?.projectId;
  const messageId = message?.messageId;
  const senderThreadId = message?.senderThreadId;
  useEffect(() => {
    if (!projectId || !messageId) return;
    let active = true;
    void rpc.call("messageFileContext", { projectId, messageId }).then((value) => {
      const parsed = fileContextSchema.safeParse(value);
      if (active && parsed.success && parsed.data.threadId === senderThreadId) setContext(parsed.data);
    }).catch(() => { /* Unresolved file links stay copyable text. */ });
    return () => { active = false; };
  }, [rpc, projectId, messageId, senderThreadId]);
  return <div data-testid="message-body" className="min-w-0 break-words text-sm leading-6">
    <ReactMarkdown remarkPlugins={[remarkBreaks]} components={{
      img: ({ alt }) => <span>{alt}</span>,
      pre: ({ children }) => <pre className="max-w-full overflow-x-auto rounded-md bg-muted/30 p-2">{children}</pre>,
      p: ({ children }) => <p className="my-1.5">{children}</p>,
      ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
      ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
      li: ({ children }) => <li className="my-0.5">{children}</li>,
      a: ({ href = "", children }) => {
        if (/^https?:\/\//i.test(href)) {
          let Icon = GlobeIcon;
          try { if (new URL(href).hostname === "github.com") Icon = GithubLogoIcon; } catch {}
          return <UrlLink href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
          if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (navigate.openUrl(href)) event.preventDefault();
        }} className="inline-flex max-w-full items-center gap-1.5 align-middle text-primary underline underline-offset-2"><Icon aria-hidden="true" size={16} className="shrink-0" /><span className="min-w-0 break-words">{children}</span></UrlLink>;
        }
        const target = localTarget(href, context);
        if (!target) return <span>{children}</span>;
        const Icon = /\.(png|jpe?g|gif|webp|avif|svg|heic|ico|bmp|tiff?)$/i.test(target.path) ? ImageIcon
          : /\.pdf$/i.test(target.path) ? FilePdfIcon
          : /\.(md|mdx|txt|log|csv|json|ya?ml|toml)$/i.test(target.path) ? FileTextIcon : FileIcon;
        return <button type="button" title="Open file preview" className="inline-flex max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 align-middle text-left text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => {
          setOpenError(!navigate.experimental_openFilePreview({ target, location: null }));
        }}><Icon aria-hidden="true" size={16} className="shrink-0" /><span className="min-w-0 break-words">{children}</span></button>;
      },
    }}>{text}</ReactMarkdown>
    {openError && <p role="alert">BB could not open this file preview.</p>}
  </div>;
}

type OperatorMessagesResult = PluginRpcResult<typeof rpcContract["operatorMessages"]>;
type OperatorMessage = OperatorMessagesResult["messages"][number];
type InboxFilters = { projectId: string; showArchived: boolean };
type PendingInboxAction = { key: string; action: "mark-read" | "archive" };
function asText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
const MAX_VISIBLE_INBOX_MESSAGES = 256;
const INBOX_FILTER_STORAGE_KEY = "operator-inbox.filters";
function readInboxFilters(): InboxFilters {
  try { const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null") as Partial<InboxFilters> | null; return { projectId: typeof value?.projectId === "string" ? value.projectId : "", showArchived: value?.showArchived === true }; }
  catch { return { projectId: "", showArchived: false }; }
}
function writeInboxFilters(filters: InboxFilters): void { try { window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters)); } catch {} }
function messageKey(message: Pick<OperatorMessage, "projectId" | "messageId">): string { return `${message.projectId}:${message.messageId}`; }
function formatExactTime(timestamp: number): string {
  const date = new Date(timestamp);
  try { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" }).format(date); }
  catch { return `${date.toISOString().replace("T", " ").replace(".000Z", "")} UTC`; }
}
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function severityLabel(severity: OperatorMessage["severity"]): string { return severity === "needs-decision" ? "Needs decision" : severity[0]!.toUpperCase() + severity.slice(1); }
function senderLabel(message: OperatorMessage): string { return asText(message.senderTitle) ?? "Sender thread"; }
function messageNumberLabel(message: Pick<OperatorMessage, "messageId">): string { return `#${message.messageId}`; }
function deliveryLabel(message: OperatorMessage): string | null {
  return message.replyAcceptedAtMs === null ? null : `Accepted by BB${message.replyDelivery ? ` · ${message.replyDelivery}` : ""}`;
}
function stateLabel(message: OperatorMessage): string {
  if (message.archivedAtMs != null) return "Archived";
  return deliveryLabel(message) ?? (message.readAtMs === null ? "Unread" : "Read");
}

function InboxPanel(_props: PluginNavPanelProps) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [filters, setFilters] = useState<InboxFilters>(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { showArchived } = filters;
  const [messages, setMessages] = useState<readonly OperatorMessage[]>([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingMessageKey, setReplyingMessageKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingInboxAction | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const selectedKey = selectedMessageKey === null ? null : selectedMessageKey && visibleMessages.some((message) => messageKey(message) === selectedMessageKey) ? selectedMessageKey : visibleMessages[0] ? messageKey(visibleMessages[0]) : null;
  const selectedMessage = selectedKey === null ? undefined : visibleMessages.find((message) => messageKey(message) === selectedKey);
  const unreadCount = messages.filter((message) => message.readAtMs === null && message.archivedAtMs === null).length;

  const setFiltersAndPersist = (next: InboxFilters) => { setFilters(next); writeInboxFilters(next); };
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    setNotice(null);
    setLoading(true);
    if (projects.length === 0) { setMessages([]); setErrors([]); setLoading(false); return; }
    const requestedProjectIds = projects.map((project) => project.id);
    void rpc.call("operatorMessages", { projectIds: requestedProjectIds, ...(showArchived ? { includeArchived: true } : {}) })
      .then((result) => {
        if (sequence !== refreshSequence.current) return;
        const allowed = new Set(requestedProjectIds);
        if (result.messages.some((message) => !allowed.has(message.projectId))) throw new Error("Operator Inbox returned a message from another project");
        setMessages(result.messages);
        setSelectedMessageKey((current) => current === undefined && result.messages[0] ? messageKey(result.messages[0]) : current);
        setErrors([]);
      })
      .catch((reason: unknown) => { if (sequence === refreshSequence.current) setErrors([String(reason)]); })
      .finally(() => { if (sequence === refreshSequence.current) setLoading(false); });
  }, [projects, rpc, showArchived]);
  useEffect(refresh, [refresh]);
  useRealtime(INBOX_CHANGED_CHANNEL, useCallback((payload: unknown) => {
    const changedProjectId = payload && typeof payload === "object" ? (payload as { projectId?: unknown }).projectId : null;
    if (typeof changedProjectId === "string" && projects.some((project) => project.id === changedProjectId)) refresh();
  }, [projects, refresh]));
  const realtimeState = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (wasConnected.current) refresh();
    wasConnected.current = true;
  }, [realtimeState, refresh]);

  const updateMessage = (next: OperatorMessage) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));
  const currentProjectLabel = projectId ? projectNames.get(projectId) ?? projectId : "All projects";
  const replyKey = selectedMessage ? messageKey(selectedMessage) : null;
  const replyText = selectedMessage && replyKey ? drafts[replyKey] ?? selectedMessage.replyText ?? "" : "";
  const selectedSenderId = selectedMessage ? asText(selectedMessage.senderThreadId) : null;
  const pendingSelectedAction = pendingAction?.key === replyKey ? pendingAction.action : null;
  const markReadPending = pendingSelectedAction === "mark-read";
  const readOperations = useRef(new Map<string, Promise<void>>());
  const markMessageRead = useCallback((projectId: string, messageId: number) => {
    const key = messageKey({ projectId, messageId });
    const existing = readOperations.current.get(key);
    if (existing) return existing;
    const action: PendingInboxAction = { key, action: "mark-read" };
    setPendingAction(action);
    const operation = rpc.call("markOperatorMessageRead", { projectId, messageId }).then((read) => {
      setMessages((current) => current.map((item) => messageKey(item) === key ? { ...item, readAtMs: item.readAtMs ?? read.readAtMs } : item));
    }).catch((reason: unknown) => {
      setErrors([`Could not mark message read: ${String(reason)}`]);
    }).finally(() => {
      readOperations.current.delete(key);
      setPendingAction((current) => current === action ? null : current);
    });
    readOperations.current.set(key, operation);
    return operation;
  }, [rpc]);
  const selectedProjectId = selectedMessage?.projectId;
  const selectedMessageId = selectedMessage?.messageId;
  const selectedReadAtMs = selectedMessage?.readAtMs;
  useEffect(() => {
    if (selectedProjectId && selectedMessageId && selectedReadAtMs === null) void markMessageRead(selectedProjectId, selectedMessageId);
  }, [selectedProjectId, selectedMessageId, selectedReadAtMs, markMessageRead]);
  const markSelectedMessageRead = () => {
    if (selectedMessage) { setErrors([]); void markMessageRead(selectedMessage.projectId, selectedMessage.messageId); }
  };
  const archiveOperations = useRef(new Map<string, Promise<OperatorMessage>>());
  const archiveMessage = (message: OperatorMessage) => {
    const key = messageKey(message);
    const existing = archiveOperations.current.get(key);
    if (existing) return existing;
    const action: PendingInboxAction = { key, action: "archive" };
    const sequence = refreshSequence.current;
    setPendingAction(action);
    setErrors([]);
    setNotice(null);
    const operation = rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId }).then((archived) => {
      if (sequence === refreshSequence.current) setMessages((current) => showArchivedRef.current ? current.map((item) => messageKey(item) === key ? archived : item) : current.filter((item) => messageKey(item) !== key));
      setNotice("Archived. Turn on Show archived to include it again.");
      return archived;
    }).catch((reason: unknown) => {
      setErrors([String(reason)]);
      throw reason;
    }).finally(() => {
      archiveOperations.current.delete(key);
      setPendingAction((current) => current === action ? null : current);
    });
    archiveOperations.current.set(key, operation);
    return operation;
  };

  return <main className="h-full min-w-0 overflow-y-auto p-3"><div className="mx-auto grid w-full min-w-0 max-w-3xl gap-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
      <p className="text-xs text-muted-foreground" aria-live="polite">{unreadCount ? `${unreadCount} unread` : "All caught up"}</p>
    </header>
    <section aria-label="Inbox toolbar" className="flex flex-wrap items-center gap-2">
      <label className="min-w-0 flex-1 basis-40"><span className="sr-only">Project</span><select className="min-h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={projectId} onChange={(event) => setFiltersAndPersist({ projectId: event.target.value, showArchived })}><option value="">All projects</option>{sidebar.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
      <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={(event) => setFiltersAndPersist({ projectId, showArchived: event.target.checked })} />Show archived</label>
      <button type="button" aria-label="Refresh inbox" title="Refresh inbox" className="flex min-h-9 min-w-9 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" onClick={refresh} disabled={loading}><ArrowClockwiseIcon aria-hidden="true" weight="duotone" size={16} /></button>
    </section>
    {errors.map((loadError) => <p role="alert" key={loadError} className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{loadError}</p>)}
    {notice ? <p role="status" className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">{notice}</p> : null}
    {sidebar.projects.length === 0 ? <section className="rounded-lg border border-dashed border-border p-6 text-center"><h2 className="font-medium">No projects available</h2><p className="mt-1 text-sm text-muted-foreground">A project is required before operator messages can appear here.</p></section> : <section aria-label={`${currentProjectLabel} messages`} className="grid min-w-0 gap-3">
      {loading ? <p role="status" className="py-3 text-sm text-muted-foreground">Loading messages…</p> : null}
      {!loading && messages.length === 0 ? <div className="rounded-lg border border-dashed border-border p-5"><p className="font-medium">No messages in this view</p><p className="mt-1 text-sm text-muted-foreground">Try another project or show archived messages.</p></div> : null}
      {messages.length > MAX_VISIBLE_INBOX_MESSAGES ? <p className="text-xs text-muted-foreground">Showing the first {MAX_VISIBLE_INBOX_MESSAGES} of {messages.length} messages. Newest messages appear first.</p> : null}
      <div role="list" aria-label="Operator messages" className="grid min-w-0 gap-3">{visibleMessages.map((message) => {
        const key = messageKey(message);
        const selected = key === selectedKey;
        const sender = senderLabel(message);
        const detailId = `message-detail-${key}`;
        const toggleId = `message-toggle-${key}`;
        return <article key={key} role="listitem" className={`min-w-0 overflow-hidden rounded-lg border bg-background ${selected ? "border-primary/50" : "border-border"}`}>
          <div className="relative grid gap-2 p-3 hover:bg-muted/30">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 flex-1"><button id={toggleId} type="button" aria-expanded={selected} aria-controls={detailId} aria-label={`${selected ? "Collapse" : "Expand"} message ${messageNumberLabel(message)} from ${sender}. ${projectNames.get(message.projectId) ?? message.projectId}. ${severityLabel(message.severity)}. ${stateLabel(message)}. ${formatExactTime(message.createdAtMs)}`} onClick={() => setSelectedMessageKey(selected ? null : key)} className="flex w-full min-w-0 items-center gap-2 text-left after:absolute after:inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                {message.readAtMs === null && <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                <span className="min-w-0 truncate text-sm font-semibold" title={sender}>{sender}</span>
              </button></h2>
              {message.archivedAtMs === null && <button type="button" aria-busy={pendingAction?.key === key && pendingAction.action === "archive"} aria-label={pendingAction?.key === key && pendingAction.action === "archive" ? "Archiving message" : "Archive message"} title="Archive message" disabled={pendingAction !== null} className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" onClick={() => { void archiveMessage(message).catch(() => undefined); }}><ArchiveIcon aria-hidden="true" weight="duotone" size={16} /></button>}
              <time className="shrink-0 text-xs font-normal text-muted-foreground" dateTime={new Date(message.createdAtMs).toISOString()} title={formatExactTime(message.createdAtMs)}>{formatRelativeTime(message.createdAtMs)}</time>
              <CaretDownIcon aria-hidden="true" size={16} className={`pointer-events-none shrink-0 text-muted-foreground ${selected ? "rotate-180" : ""}`} />
            </div>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground"><span className="font-mono">{messageNumberLabel(message)}</span><span>{projectNames.get(message.projectId) ?? message.projectId}</span><span className={message.severity === "routine" ? "" : "font-medium text-foreground"}>{severityLabel(message.severity)}</span>{message.archivedAtMs != null ? <span>Archived</span> : deliveryLabel(message) ? <span>{deliveryLabel(message)}</span> : null}</span>
            {!selected && <span className="line-clamp-2 break-words text-sm font-normal leading-5 text-muted-foreground">{message.text}</span>}
          </div>
          <div id={detailId} role="region" aria-labelledby={toggleId} hidden={!selected}>
            {selected && selectedMessage && <div className="grid min-w-0 gap-4 border-t border-border p-3">
              {selectedSenderId && <a href="#" className="w-fit max-w-full break-words text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Open sender thread ${senderLabel(selectedMessage)}`} onClick={(event) => { event.preventDefault(); navigate.toThread(selectedSenderId); }}>Open sender thread</a>}
              <MessageBody key={messageKey(selectedMessage)} text={selectedMessage.text} message={selectedMessage} />
          {selectedMessage.replyAcceptedAtMs != null ? <section aria-label="Reply accepted by BB" className="grid gap-2 rounded-md border border-border bg-muted/10 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Reply accepted by BB</h3><time className="text-xs text-muted-foreground" dateTime={new Date(selectedMessage.replyAcceptedAtMs).toISOString()} title={formatExactTime(selectedMessage.replyAcceptedAtMs)} aria-label={`Accepted ${formatExactTime(selectedMessage.replyAcceptedAtMs)}`}>{formatRelativeTime(selectedMessage.replyAcceptedAtMs)}</time></div><MessageBody text={selectedMessage.replyText ?? ""} /><p className="text-xs text-muted-foreground">BB reported {selectedMessage.replyDelivery ?? "accepted"}. Provider consumption is not observed.</p></section> : <section aria-label="Reply to sender" className="grid gap-3 border-t border-border pt-4"><label className="grid gap-1 text-sm" htmlFor={`operator-reply-${replyKey}`}><span className="sr-only">Reply text</span><textarea placeholder="Reply to sender" id={`operator-reply-${replyKey}`} className="min-h-24 w-full rounded-md border border-border bg-background p-2.5 text-sm leading-5 focus:bg-muted/50 focus:outline-none focus:ring-0" value={replyText} onChange={(event) => setDrafts((current) => ({ ...current, [replyKey!]: event.target.value }))} /></label></section>}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4"><button type="button" aria-label={replyingMessageKey === replyKey ? "Sending reply" : selectedMessage.replyAcceptedAtMs != null ? "Reply accepted by BB" : "Send reply"} title={replyingMessageKey === replyKey ? "Sending reply" : selectedMessage.replyAcceptedAtMs != null ? "Reply accepted by BB" : "Send reply"} disabled={replyingMessageKey !== null || pendingAction !== null || selectedMessage.replyAcceptedAtMs != null || !replyText.trim()} className="min-h-10 min-w-10 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none" onClick={() => { const text = replyText.trim(); if (!text || !replyKey) return; setErrors([]); setNotice(null); setReplyingMessageKey(replyKey); void rpc.call("replyToOperatorMessage", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId, text }).then((replied) => { updateMessage(replied); setNotice(`Reply accepted by BB (${replied.replyDelivery ?? "accepted"}). Provider consumption is not observed.`); }).catch((reason: unknown) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null)); }}><PaperPlaneTiltIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button>{selectedMessage.readAtMs === null ? <button type="button" aria-busy={markReadPending} aria-label={markReadPending ? "Marking message read" : "Mark message read"} title={markReadPending ? "Marking message read" : "Mark message read"} disabled={pendingAction !== null} className="min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none" onClick={markSelectedMessageRead}><EnvelopeOpenIcon aria-hidden="true" focusable="false" color="currentColor" weight="duotone" size={18} /></button> : null}</div>
            </div>}
          </div>

        </article>;
      })}</div>
    </section>}
  </div></main>;
}

function InboxUnreadAccessory() {
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const projectIds = useMemo(() => sidebar.projects.map(({ id }) => id), [sidebar.projects]);
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (projectIds.length === 0) { setUnread(0); return; }
    void rpc.call("unreadOperatorMessageCount", { projectIds }).then(({ count }) => setUnread(count), () => undefined);
  }, [projectIds, rpc]);

  useEffect(refresh, [refresh]);
  useRealtime(INBOX_CHANGED_CHANNEL, useCallback((payload: unknown) => {
    const changedProjectId = payload && typeof payload === "object" ? (payload as { projectId?: unknown }).projectId : null;
    if (typeof changedProjectId === "string" && projectIds.includes(changedProjectId)) refresh();
  }, [projectIds, refresh]));
  const realtimeState = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (wasConnected.current) refresh();
    wasConnected.current = true;
  }, [realtimeState, refresh]);

  if (unread < 1) return null;
  const label = `${unread} unread operator ${unread === 1 ? "message" : "messages"}`;
  return <span role="status" aria-live="polite" aria-label={label} title={label} className="max-w-full truncate rounded-full bg-primary px-1.5 text-xs font-semibold leading-5 text-primary-foreground">{unread}</span>;
}

export default definePluginApp((app) => { app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "./assets/envelope-simple-duotone.svg", path: "inbox", component: InboxPanel, experimental_sidebarAccessory: InboxUnreadAccessory }); });
