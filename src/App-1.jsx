import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'

const DEFAULT_CONFIG = {
  symbol: 'MX/USDT',
  order_qty: 10,
  initial_price: '',
  max_price_ceiling: '',
  tick_size: 0.000001,
  min_reprice_interval_sec: 1.0,
  max_reprices_per_session: 50,
}

export default function App() {
  const [session, setSession] = useState(null)
  const [loadingSession, setLoadingSession] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoadingSession(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (loadingSession) {
    return <CenterScreen><Pulse label="Loading" /></CenterScreen>
  }

  return session ? <Dashboard session={session} /> : <AuthScreen />
}

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------
function AuthScreen() {
  const [mode, setMode] = useState('sign_in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const fn = mode === 'sign_in'
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password })
    const { error } = await fn
    setBusy(false)
    if (error) setError(error.message)
  }

  return (
    <CenterScreen>
      <div className="w-full max-w-sm">
        <Wordmark />
        <form onSubmit={submit} className="mt-8 space-y-4">
          <Field label="Email">
            <input
              type="email" required value={email} onChange={e => setEmail(e.target.value)}
              className="input" placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <input
              type="password" required value={password} onChange={e => setPassword(e.target.value)}
              className="input" placeholder="••••••••" minLength={6}
            />
          </Field>
          {error && <p className="text-fall text-sm font-mono">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Working…' : mode === 'sign_in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button
          className="mt-4 text-sm text-mute hover:text-paper transition-colors"
          onClick={() => setMode(m => m === 'sign_in' ? 'sign_up' : 'sign_in')}
        >
          {mode === 'sign_in' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
        </button>
      </div>
    </CenterScreen>
  )
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
function Dashboard({ session }) {
  const userId = session.user.id
  const [config, setConfig] = useState(null)
  const [hasCreds, setHasCreds] = useState(false)
  const [sessionRow, setSessionRow] = useState(null)
  const [logs, setLogs] = useState([])
  const [tab, setTab] = useState('control')

  // Load existing config + credential presence on mount
  useEffect(() => {
    (async () => {
      const { data: cfg } = await supabase
        .from('bot_configs').select('*').eq('user_id', userId).maybeSingle()
      if (cfg) setConfig(cfg)
      else setConfig({ ...DEFAULT_CONFIG })

      const { count } = await supabase
        .from('api_credentials').select('id', { count: 'exact', head: true }).eq('user_id', userId)
      setHasCreds((count ?? 0) > 0)

      const { data: latestSession } = await supabase
        .from('bot_sessions').select('*').eq('user_id', userId)
        .order('started_at', { ascending: false }).limit(1).maybeSingle()
      if (latestSession) setSessionRow(latestSession)
    })()
  }, [userId])

  // Realtime: session status + logs
  useEffect(() => {
    const channel = supabase
      .channel(`user-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_sessions', filter: `user_id=eq.${userId}` },
        (payload) => setSessionRow(payload.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bot_logs', filter: `user_id=eq.${userId}` },
        (payload) => setLogs(prev => [...prev.slice(-199), payload.new]))
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [userId])

  if (!config) return <CenterScreen><Pulse label="Loading dashboard" /></CenterScreen>

  return (
    <div className="min-h-screen bg-ink">
      <Header email={session.user.email} />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <StatusBar sessionRow={sessionRow} />

        <div className="mt-6 flex gap-1 border-b border-line">
          {['control', 'credentials', 'activity'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px
                ${tab === t ? 'border-ember text-paper' : 'border-transparent text-mute hover:text-paper'}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {tab === 'control' && (
            <ControlPanel
              userId={userId} config={config} setConfig={setConfig}
              hasCreds={hasCreds} sessionRow={sessionRow}
            />
          )}
          {tab === 'credentials' && (
            <CredentialsPanel userId={userId} hasCreds={hasCreds} setHasCreds={setHasCreds} />
          )}
          {tab === 'activity' && <ActivityFeed logs={logs} />}
        </div>
      </main>
    </div>
  )
}

function Header({ email }) {
  return (
    <header className="border-b border-line">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Wordmark small />
        <div className="flex items-center gap-4">
          <span className="text-sm text-mute font-mono hidden sm:block">{email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-mute hover:text-paper transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}

function Wordmark({ small }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block rounded-full bg-ember ${small ? 'w-2 h-2' : 'w-2.5 h-2.5'}`} />
      <span className={`font-display font-bold tracking-tight ${small ? 'text-lg' : 'text-2xl'}`}>
        Tickwise
      </span>
    </div>
  )
}

// ---------------------------------------------------------------
// Status bar — the signature element: a live ticking readout
// ---------------------------------------------------------------
function StatusBar({ sessionRow }) {
  const status = sessionRow?.status ?? 'stopped'
  const colors = {
    running: 'text-rise', starting: 'text-ember', stopped: 'text-mute', error: 'text-fall',
  }
  const dot = {
    running: 'bg-rise animate-pulse', starting: 'bg-ember animate-pulse', stopped: 'bg-mute', error: 'bg-fall',
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-5 flex flex-wrap items-center gap-x-8 gap-y-3">
      <div className="flex items-center gap-2.5">
        <span className={`w-2 h-2 rounded-full ${dot[status]}`} />
        <span className={`font-mono text-sm uppercase tracking-wide ${colors[status]}`}>{status}</span>
      </div>
      <Stat label="Current bid" value={sessionRow?.current_bid ? `$${sessionRow.current_bid}` : '—'} />
      <Stat label="Reprices" value={sessionRow?.reprice_count ?? 0} />
      <Stat label="Order ID" value={sessionRow?.current_order_id ?? '—'} mono small />
    </div>
  )
}

function Stat({ label, value, mono, small }) {
  return (
    <div>
      <div className="text-xs text-mute uppercase tracking-wide">{label}</div>
      <div className={`mt-0.5 ${mono ? 'font-mono' : 'font-mono'} ${small ? 'text-sm' : 'text-lg'} text-paper tabular`}>
        {value}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// Control panel — config form + start/stop
// ---------------------------------------------------------------
function ControlPanel({ userId, config, setConfig, hasCreds, sessionRow }) {
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const isRunning = sessionRow?.status === 'running' || sessionRow?.status === 'starting'

  function update(field, value) {
    setConfig(c => ({ ...c, [field]: value }))
  }

  async function saveConfig() {
    setSaving(true)
    setError('')
    const { data, error } = await supabase
      .from('bot_configs')
      .upsert({ ...config, user_id: userId }, { onConflict: 'user_id' })
      .select().single()
    setSaving(false)
    if (error) setError(error.message)
    else setConfig(data)
  }

  async function toggleBot() {
    if (!hasCreds) {
      setError('Add your MEXC API credentials in the Credentials tab first.')
      return
    }
    setStarting(true)
    setError('')
    try {
      const endpoint = isRunning ? '/api/stop-bot' : '/api/start-bot'
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ config_id: config.id }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || 'Request failed')
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="grid sm:grid-cols-2 gap-5">
      <Field label="Trading pair">
        <input className="input" value={config.symbol} onChange={e => update('symbol', e.target.value)} />
      </Field>
      <Field label="Order quantity">
        <input type="number" step="any" className="input" value={config.order_qty}
          onChange={e => update('order_qty', e.target.value)} />
      </Field>
      <Field label="Starting bid price">
        <input type="number" step="any" className="input" value={config.initial_price}
          onChange={e => update('initial_price', e.target.value)} placeholder="0.001560" />
      </Field>
      <Field label="Max price ceiling" hint="Bot never bids above this">
        <input type="number" step="any" className="input" value={config.max_price_ceiling}
          onChange={e => update('max_price_ceiling', e.target.value)} placeholder="0.001650" />
      </Field>
      <Field label="Tick size">
        <input type="number" step="any" className="input" value={config.tick_size}
          onChange={e => update('tick_size', e.target.value)} />
      </Field>
      <Field label="Min. seconds between reprices" hint="Throttle, protects against rate limits">
        <input type="number" step="any" className="input" value={config.min_reprice_interval_sec}
          onChange={e => update('min_reprice_interval_sec', e.target.value)} />
      </Field>
      <Field label="Max reprices per session" hint="Circuit breaker for bidding wars">
        <input type="number" className="input" value={config.max_reprices_per_session}
          onChange={e => update('max_reprices_per_session', e.target.value)} />
      </Field>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-2">
        <button onClick={saveConfig} disabled={saving} className="btn-secondary">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button
          onClick={toggleBot}
          disabled={starting}
          className={isRunning ? 'btn-stop' : 'btn-primary'}
        >
          {starting ? 'Working…' : isRunning ? 'Stop bot' : 'Start bot'}
        </button>
        {!hasCreds && (
          <span className="text-sm text-ember font-mono">Add API credentials to enable trading</span>
        )}
      </div>
      {error && <p className="sm:col-span-2 text-fall text-sm font-mono">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------
// Credentials panel
// ---------------------------------------------------------------
function CredentialsPanel({ userId, hasCreds, setHasCreds }) {
  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedOk, setSavedOk] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    setSavedOk(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ api_key: apiKey, secret_key: secretKey }),
      })
      if (!res.ok) throw new Error('Could not save credentials')
      setHasCreds(true)
      setSavedOk(true)
      setApiKey('')
      setSecretKey('')
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-md">
      <p className="text-sm text-mute mb-5">
        Create a MEXC API key with <span className="text-paper">Spot Trade</span> permission only.
        Never enable withdrawal permission. Keys are encrypted before storage and never shown again after saving.
      </p>
      {hasCreds && (
        <div className="mb-5 rounded-md border border-line bg-panel px-4 py-3 text-sm font-mono text-rise">
          ✓ Credentials on file
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="MEXC API key">
          <input required className="input font-mono" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        </Field>
        <Field label="MEXC secret key">
          <input required type="password" className="input font-mono" value={secretKey} onChange={e => setSecretKey(e.target.value)} />
        </Field>
        {error && <p className="text-fall text-sm font-mono">{error}</p>}
        {savedOk && <p className="text-rise text-sm font-mono">Saved securely.</p>}
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : hasCreds ? 'Replace credentials' : 'Save credentials'}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------
// Activity feed — ticker-tape style live log
// ---------------------------------------------------------------
function ActivityFeed({ logs }) {
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [logs])

  const levelColor = { info: 'text-paper', warning: 'text-ember', error: 'text-fall' }

  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="h-96 overflow-y-auto p-4 font-mono text-sm space-y-1.5">
        {logs.length === 0 && <p className="text-mute">No activity yet. Start the bot to see live updates here.</p>}
        {logs.map(l => (
          <div key={l.id} className="flex gap-3">
            <span className="text-mute shrink-0 tabular">
              {new Date(l.created_at).toLocaleTimeString()}
            </span>
            <span className={levelColor[l.level] ?? 'text-paper'}>{l.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------
function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm text-paper font-medium">{label}</span>
      {hint && <span className="block text-xs text-mute mt-0.5">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

function CenterScreen({ children }) {
  return <div className="min-h-screen bg-ink flex items-center justify-center px-4">{children}</div>
}

function Pulse({ label }) {
  return (
    <div className="flex items-center gap-2 text-mute font-mono text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-ember animate-pulse" />
      {label}…
    </div>
  )
}
