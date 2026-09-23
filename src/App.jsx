import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'

const DEFAULT_CONFIG = {
  exchange: 'mexc',
  symbol: '',
  order_qty: 10,
  initial_price: '',
  max_price_ceiling: '',
  tick_size: 0.000001,
  min_reprice_interval_sec: 1.0,
  max_reprices_per_session: 50,
  min_competitor_value: '',
  max_competitor_value: '',
  instant_buy_enabled: false,
  instant_buy_min_price: '',
  instant_buy_max_price: '',
}

// Curated list of ccxt exchange ids confirmed to support the WebSocket
// order-book streaming this bot relies on. Not an exhaustive list of every
// ccxt-supported exchange — just ones worth surfacing as presets. The bot's
// own pre-flight check (via exchange.has) is the real source of truth if
// support ever changes.
const SUPPORTED_EXCHANGES = [
  { id: 'mexc', name: 'MEXC' },
  { id: 'binance', name: 'Binance' },
  { id: 'bybit', name: 'Bybit' },
  { id: 'okx', name: 'OKX' },
  { id: 'gate', name: 'Gate.io' },
  { id: 'kucoin', name: 'KuCoin' },
]

export default function App() {
  const [session, setSession] = useState(null)
  const [loadingSession, setLoadingSession] = useState(true)

  useEffect(() => {
    // Force a fresh sign-in every time the app loads, regardless of how
    // recently the user last authenticated (2 minutes or 2 days). Supabase
    // persists sessions in localStorage by default, so a plain getSession()
    // would silently resume an old session. We clear it locally first so
    // the person always lands on the Sign in / Sign up screen.
    // scope: 'local' only clears the token on THIS device -- it does not
    // invalidate the person's session on any other device they're signed
    // into, and it does not touch or stop any bot session already running
    // on the backend (that's tracked independently in bot_sessions).
    (async () => {
      await supabase.auth.signOut({ scope: 'local' })
      setSession(null)
      setLoadingSession(false)
    })()

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

  // Checks whether the user has credentials saved for a given exchange via
  // a server-side endpoint. api_credentials has RLS policies for INSERT and
  // UPDATE only (no SELECT) so the encrypted keys can never be read back out
  // by the client -- but that also means a direct client-side count query
  // gets silently blocked and always reads as "0 credentials", even when
  // they're saved and working. This calls /api/check-credentials instead,
  // which uses the service role key server-side and returns only a boolean.
  async function checkHasCreds(exchange) {
    try {
      const res = await fetch(`/api/check-credentials?exchange=${encodeURIComponent(exchange)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) return false
      const body = await res.json().catch(() => ({}))
      return !!body.hasCreds
    } catch {
      return false
    }
  }

  // Load existing config + credential presence on mount
  useEffect(() => {
    (async () => {
      const { data: cfg, error: cfgError } = await supabase
        .from('bot_configs').select('*').eq('user_id', userId).maybeSingle()
      // Surface load errors instead of silently falling back to defaults --
      // this used to fail silently whenever a user had more than one config
      // row (a pre-existing DB bug, now fixed via a unique constraint on
      // user_id), masking the problem instead of showing it.
      if (cfgError) console.error('Failed to load config:', cfgError.message)
      if (cfg) setConfig(cfg)
      else setConfig({ ...DEFAULT_CONFIG })

      setHasCreds(await checkHasCreds(cfg?.exchange || DEFAULT_CONFIG.exchange))

      const { data: latestSession } = await supabase
        .from('bot_sessions').select('*').eq('user_id', userId)
        .order('started_at', { ascending: false }).limit(1).maybeSingle()
      if (latestSession) setSessionRow(latestSession)
    })()
  }, [userId])

  // Re-check credential presence whenever the selected exchange changes —
  // a user may have keys saved for MEXC but not Binance, for example.
  useEffect(() => {
    if (!config?.exchange) return
    (async () => {
      setHasCreds(await checkHasCreds(config.exchange))
    })()
  }, [userId, config?.exchange])

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
              hasCreds={hasCreds} sessionRow={sessionRow} setSessionRow={setSessionRow}
            />
          )}
          {tab === 'credentials' && (
            <CredentialsPanel userId={userId} exchange={config.exchange || 'mexc'}
              hasCreds={hasCreds} setHasCreds={setHasCreds} />
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
  const rawStatus = sessionRow?.status ?? 'stopped'
  // "Reconnecting" isn't a separate DB status value (no schema change needed) --
  // it's status='running' with a RECONNECTING: marker in last_decision, set by
  // bot_task.py while it's rebuilding a dead exchange connection. Detected here
  // purely for display.
  const isReconnecting = rawStatus === 'running' && sessionRow?.last_decision?.startsWith('RECONNECTING:')
  const status = isReconnecting ? 'reconnecting' : rawStatus

  const colors = {
    running: 'text-rise', starting: 'text-ember', stopped: 'text-mute', error: 'text-fall',
    reconnecting: 'text-ember',
  }
  const dot = {
    running: 'bg-rise animate-pulse', starting: 'bg-ember animate-pulse', stopped: 'bg-mute', error: 'bg-fall',
    reconnecting: 'bg-ember animate-pulse',
  }
  const labels = {
    running: 'running', starting: 'starting', stopped: 'stopped', error: 'error',
    reconnecting: 'reconnecting…',
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-5 flex flex-wrap items-center gap-x-8 gap-y-3">
      <div className="flex items-center gap-2.5">
        <span className={`w-2 h-2 rounded-full ${dot[status]}`} />
        <span className={`font-mono text-sm uppercase tracking-wide ${colors[status]}`}>{labels[status]}</span>
      </div>
      <Stat label="Current bid" value={sessionRow?.current_bid ? `$${sessionRow.current_bid}` : '—'} />
      <Stat label="Reprices" value={sessionRow?.reprice_count ?? 0} />
      <Stat label="Instant buys" value={sessionRow?.instant_buy_count ?? 0} />
      <Stat label="Order ID" value={sessionRow?.current_order_id ?? '—'} mono small />
      {isReconnecting && (
        <div className="w-full rounded-md border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
          Connection lost — attempting recovery.
        </div>
      )}
      {rawStatus === 'error' && sessionRow?.error_message && (
        <div className="w-full rounded-md border border-fall/40 bg-fall/10 px-3 py-2 text-sm text-fall">
          {sessionRow.error_message}
        </div>
      )}
      {sessionRow?.last_decision && (
        <div className="w-full pt-2 border-t border-line">
          <div className="text-xs text-mute uppercase tracking-wide mb-1">Last decision</div>
          <div className="font-mono text-xs text-paper break-words">{sessionRow.last_decision}</div>
        </div>
      )}
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
function ControlPanel({ userId, config, setConfig, hasCreds, sessionRow, setSessionRow }) {
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [killing, setKilling] = useState(false)
  const [killResult, setKillResult] = useState(null)
  const [instantBuySaving, setInstantBuySaving] = useState(false)
  const isRunning = sessionRow?.status === 'running' || sessionRow?.status === 'starting'
  const isError = sessionRow?.status === 'error'

  // Force Stop is deliberately NOT a second button sitting next to Stop --
  // it's a harder interrupt (see force-stop-bot.js) with a real, if rare,
  // edge case a normal Stop doesn't have: if it hits at the exact moment
  // an order request has already reached the exchange but the confirmation
  // hasn't come back yet, the order can still get placed without the bot
  // ever learning its order ID to track it. So it only appears as an
  // escalation, after a normal Stop has genuinely been tried and hasn't
  // taken effect -- not as an easy first choice.
  const FORCE_STOP_REVEAL_SEC = 20
  const [stopRequestedAt, setStopRequestedAt] = useState(null)
  const [forcing, setForcing] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!stopRequestedAt) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [stopRequestedAt])
  useEffect(() => {
    // A stop that actually took effect clears the escalation state --
    // only a stop that's genuinely stuck should ever reveal Force Stop.
    if (!isRunning) setStopRequestedAt(null)
  }, [isRunning])
  const secondsSinceStopRequested = stopRequestedAt ? (Date.now() - stopRequestedAt) / 1000 : 0
  const showForceStop = stopRequestedAt !== null && isRunning && secondsSinceStopRequested >= FORCE_STOP_REVEAL_SEC

  function update(field, value) {
    setConfig(c => ({ ...c, [field]: value }))
  }

  async function saveConfig() {
    setError('')

    // Symbol is required and must be trimmed -- an untrimmed value like
    // " MATH/USDT" (leading space) is a DIFFERENT string to the DB and to
    // MEXC's API than "MATH/USDT", which caused two real bugs: phantom
    // duplicate config rows, and "MEXC does not support the trading pair"
    // errors on symbols that actually exist.
    const trimmedSymbol = (config.symbol || '').trim()
    if (!trimmedSymbol) {
      setError('Enter a trading pair before saving.')
      return null
    }

    // Normalize blanks to null (unset) rather than empty strings, and
    // validate the competitor-value range client-side before it ever
    // reaches the DB check constraint.
    const minV = config.min_competitor_value === '' || config.min_competitor_value == null
      ? null : Number(config.min_competitor_value)
    const maxV = config.max_competitor_value === '' || config.max_competitor_value == null
      ? null : Number(config.max_competitor_value)
    if (minV !== null && minV < 0) {
      setError('Min. competitor order value cannot be negative.')
      return null
    }
    if (maxV !== null && maxV < 0) {
      setError('Max. competitor order value cannot be negative.')
      return null
    }
    if (minV !== null && maxV !== null && maxV < minV) {
      setError('Max. competitor order value cannot be lower than the minimum.')
      return null
    }

    // Same normalize-blanks-to-null treatment for the instant-buy range --
    // this form field only ever edits the price band, never the toggle
    // itself (that's saved instantly by toggleInstantBuy below), so it's
    // safe to just carry whatever instant_buy_enabled already is.
    const ibMinV = config.instant_buy_min_price === '' || config.instant_buy_min_price == null
      ? null : Number(config.instant_buy_min_price)
    const ibMaxV = config.instant_buy_max_price === '' || config.instant_buy_max_price == null
      ? null : Number(config.instant_buy_max_price)
    if (ibMinV !== null && ibMinV < 0) {
      setError('Instant-buy min price cannot be negative.')
      return null
    }
    if (ibMaxV !== null && ibMaxV < 0) {
      setError('Instant-buy max price cannot be negative.')
      return null
    }
    if (ibMinV !== null && ibMaxV !== null && ibMaxV < ibMinV) {
      setError('Instant-buy max price cannot be lower than the min price.')
      return null
    }

    setSaving(true)
    // Drop any id carried over from a previously-loaded config. Letting
    // Postgres/ON CONFLICT decide the id is safer than reusing a stale one.
    // onConflict is 'user_id' (not 'user_id,symbol') -- there is now exactly
    // ONE config row per user, ever. Changing the symbol updates that same
    // row instead of creating a new one. This matches the unique constraint
    // added via the bot_configs_user_id_key migration.
    const { id, ...configWithoutId } = config
    const { data, error } = await supabase
      .from('bot_configs')
      .upsert(
        {
          ...configWithoutId,
          symbol: trimmedSymbol,
          user_id: userId,
          min_competitor_value: minV,
          max_competitor_value: maxV,
          instant_buy_min_price: ibMinV,
          instant_buy_max_price: ibMaxV,
        },
        { onConflict: 'user_id' },
      )
      .select().single()
    setSaving(false)
    if (error) {
      setError(error.message)
      return null
    }
    setConfig(data)
    return data
  }

  async function toggleBot() {
    if (!isRunning && !(config.symbol || '').trim()) {
      setError('Enter a trading pair before starting.')
      return
    }
    if (!hasCreds) {
      setError(`Add your ${config.exchange?.toUpperCase() || 'exchange'} API credentials in the Credentials tab first.`)
      return
    }
    setStarting(true)
    setError('')
    try {
      const endpoint = isRunning ? '/api/stop-bot' : '/api/start-bot'

      // Always persist the current form state before Start, not just when
      // there's no config id yet. Previously this only ran for first-time
      // users (config.id missing), so an EXISTING user who edited the
      // symbol (or any other field) and clicked Start without clicking
      // "Save settings" first would silently launch using the OLD saved
      // config -- their edits were discarded, and the bot kept trading
      // whatever symbol was last saved. Re-saving here every time closes
      // that gap. saveConfig() is a safe upsert keyed on (user_id, symbol),
      // so calling it on every Start is not destructive.
      let activeConfigId = config.id
      if (!isRunning) {
        const saved = await saveConfig()
        if (!saved) {
          setStarting(false)
          return  // saveConfig() already set the error message
        }
        activeConfigId = saved.id
      }

      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ config_id: activeConfigId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || 'Request failed')
      }
      if (isRunning) setStopRequestedAt(Date.now())  // start the Force Stop reveal countdown
    } catch (e) {
      setError(e.message)
    } finally {
      setStarting(false)
    }
  }

  // "New session" is a purely local reset -- it clears the visible form back
  // to blank defaults and clears the displayed status/error card, but never
  // touches Supabase. The old saved config and the old session's history stay
  // exactly as they were. This exists because after a failed/old session, the
  // dashboard (correctly) keeps showing that last real state until something
  // new actually happens -- which reads as "stuck" when you want to configure
  // a fresh pair from a clean slate instead of editing over the old one.
  function startNewSession() {
    setConfig({ ...DEFAULT_CONFIG })
    setSessionRow(null)
    setError('')
  }

  async function forceStop() {
    setForcing(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/force-stop-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || 'Request failed')
      }
      setStopRequestedAt(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setForcing(false)
    }
  }

  // Talks directly to the exchange rather than trusting Supabase's picture
  // of "what's running" -- this is the answer to "I don't trust that a
  // resting order is really gone." It fetches every currently-open order
  // on the exchange for the saved symbol and cancels each one, regardless
  // of whether the bot ever knew that order existed. Confirmed with a
  // native dialog first since this touches real orders on a live account
  // and can't be undone.
  async function killOrders() {
    if (!window.confirm(
      `This will cancel EVERY open order on ${config.exchange?.toUpperCase() || 'the exchange'} ` +
      `for ${config.symbol || 'your saved pair'} right now, directly on the exchange -- ` +
      `not just stop the bot watching it. This can't be undone. Continue?`
    )) return

    setKilling(true)
    setError('')
    setKillResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/kill-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.detail || 'Request failed')
      setKillResult(body)
      setStopRequestedAt(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setKilling(false)
    }
  }

  // Instant-buy is a fully independent, optional feature (see
  // check_instant_buy in decision_engine.py / bot_task.py): while enabled,
  // if a sell order is resting anywhere inside [min, max] the bot buys it
  // immediately -- running alongside the normal passive order above, not
  // instead of it. The toggle saves straight to Supabase the moment it's
  // clicked, independent of "Save settings", so flipping it on/off takes
  // effect within a few seconds even while the bot is already running --
  // matching the whole point of this being a live on/off switch, not
  // something that needs a restart. It reuses the same order quantity as
  // the main config, not a separate one.
  async function toggleInstantBuy() {
    const newEnabled = !config.instant_buy_enabled
    if (newEnabled) {
      const minV = config.instant_buy_min_price === '' ? NaN : Number(config.instant_buy_min_price)
      const maxV = config.instant_buy_max_price === '' ? NaN : Number(config.instant_buy_max_price)
      if (Number.isNaN(minV) || Number.isNaN(maxV)) {
        setError('Enter both an instant-buy min and max price before turning it on.')
        return
      }
      if (maxV < minV) {
        setError('Instant-buy max price cannot be lower than the min price.')
        return
      }
    }
    setInstantBuySaving(true)
    setError('')
    const { data, error } = await supabase
      .from('bot_configs')
      .update({
        instant_buy_enabled: newEnabled,
        instant_buy_min_price: config.instant_buy_min_price === '' ? null : Number(config.instant_buy_min_price),
        instant_buy_max_price: config.instant_buy_max_price === '' ? null : Number(config.instant_buy_max_price),
      })
      .eq('user_id', userId)
      .select().single()
    setInstantBuySaving(false)
    if (error) {
      setError(error.message)
      return
    }
    setConfig(data)
  }

  return (
    <div className="grid sm:grid-cols-2 gap-5">
      <Field label="Exchange">
        <select className="input" value={config.exchange || 'mexc'}
          onChange={e => update('exchange', e.target.value)}>
          {SUPPORTED_EXCHANGES.map(ex => (
            <option key={ex.id} value={ex.id}>{ex.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Trading pair">
        <input className="input" value={config.symbol} onChange={e => update('symbol', e.target.value)}
          placeholder="e.g. MASS/USDT" />
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
      <Field label="Min. competitor order value (USDT)" hint="Ignore competing bids smaller than this — leave blank to react to any size">
        <input type="number" step="any" min="0" className="input" value={config.min_competitor_value ?? ''}
          onChange={e => update('min_competitor_value', e.target.value)} placeholder="e.g. 20" />
      </Field>
      <Field label="Max. competitor order value (USDT)" hint="Ignore competing bids larger than this — leave blank for unlimited">
        <input type="number" step="any" min="0" className="input" value={config.max_competitor_value ?? ''}
          onChange={e => update('max_competitor_value', e.target.value)} placeholder="unlimited" />
      </Field>

      <div className="sm:col-span-2 pt-4 border-t border-line">
        <div className="text-sm text-paper font-medium">Instant buy</div>
        <p className="text-xs text-mute mt-0.5 mb-3">
          Optional and separate from the order above. While on, if a sell order is resting anywhere
          in this price range, the bot buys it immediately at the same order quantity — the passive
          order above keeps running unaffected the whole time.
        </p>
      </div>
      <Field label="Instant-buy min price">
        <input type="number" step="any" className="input" value={config.instant_buy_min_price}
          onChange={e => update('instant_buy_min_price', e.target.value)} placeholder="0.002000" />
      </Field>
      <Field label="Instant-buy max price">
        <input type="number" step="any" className="input" value={config.instant_buy_max_price}
          onChange={e => update('instant_buy_max_price', e.target.value)} placeholder="0.003000" />
      </Field>
      <div className="sm:col-span-2 -mt-2">
        <button
          onClick={toggleInstantBuy}
          disabled={instantBuySaving}
          className={config.instant_buy_enabled ? 'btn-stop' : 'btn-secondary'}
        >
          {instantBuySaving
            ? 'Saving…'
            : config.instant_buy_enabled ? 'Instant buy: ON — tap to turn off' : 'Instant buy: OFF — tap to turn on'}
        </button>
      </div>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3 pt-2">
        <button onClick={saveConfig} disabled={saving} className="btn-secondary">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button
          onClick={toggleBot}
          disabled={starting || (!isRunning && !(config.symbol || '').trim())}
          className={isRunning ? 'btn-stop' : 'btn-primary'}
        >
          {starting ? 'Working…' : isRunning ? 'Stop bot' : isError ? 'Restart bot' : 'Start bot'}
        </button>
        {!isRunning && (
          <button onClick={startNewSession} className="btn-secondary">
            New session
          </button>
        )}
        {hasCreds && (
          <button onClick={killOrders} disabled={killing} className="btn-stop">
            {killing ? 'Cancelling on exchange…' : 'Cancel all orders on exchange'}
          </button>
        )}
        {!hasCreds && (
          <span className="text-sm text-ember font-mono">Add API credentials to enable trading</span>
        )}
      </div>

      {killResult && (
        <div className="sm:col-span-2 rounded-md border border-line bg-panel px-4 py-3 text-sm font-mono">
          {killResult.cancelled.length === 0 && killResult.failed.length === 0 && (
            <span className="text-mute">No open orders found on the exchange for {killResult.symbol} — nothing to cancel.</span>
          )}
          {killResult.cancelled.length > 0 && (
            <div className="text-rise">Cancelled {killResult.cancelled.length} order(s) for {killResult.symbol} on the exchange.</div>
          )}
          {killResult.failed.length > 0 && (
            <div className="text-fall mt-1">
              {killResult.failed.length} order(s) could not be cancelled — check the exchange directly:
              {killResult.failed.map(f => <div key={f.order_id} className="ml-2">• {f.order_id}: {f.error}</div>)}
            </div>
          )}
        </div>
      )}

      {showForceStop && (
        <div className="sm:col-span-2 rounded-md border border-fall/40 bg-fall/10 px-4 py-3 space-y-2">
          <p className="text-sm text-fall">
            Stop was requested {Math.floor(secondsSinceStopRequested)}s ago and the bot hasn't
            stopped yet. Force Stop interrupts it immediately, wherever it currently is — in rare
            cases this can leave an order placed on the exchange that isn't tracked here afterward,
            so check the exchange directly once it's done if that matters to you.
          </p>
          <button onClick={forceStop} disabled={forcing} className="btn-stop">
            {forcing ? 'Force stopping…' : 'Force stop'}
          </button>
        </div>
      )}
      {error && <p className="sm:col-span-2 text-fall text-sm font-mono">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------
// Credentials panel
// ---------------------------------------------------------------
function CredentialsPanel({ userId, exchange, hasCreds, setHasCreds }) {
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
        body: JSON.stringify({ api_key: apiKey, secret_key: secretKey, exchange }),
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
        Create a{' '}<span className="text-paper">{exchange.toUpperCase()}</span> API key with{' '}
        <span className="text-paper">Spot Trade</span> permission only.
        Never enable withdrawal permission. Keys are encrypted before storage and never shown again after saving.
      </p>
      {hasCreds && (
        <div className="mb-5 rounded-md border border-line bg-panel px-4 py-3 text-sm font-mono text-rise">
          ✓ Credentials on file for {exchange.toUpperCase()}
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label={`${exchange.toUpperCase()} API key`}>
          <input required className="input font-mono" value={apiKey} onChange={e => setApiKey(e.target.value)} />
        </Field>
        <Field label={`${exchange.toUpperCase()} secret key`}>
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
