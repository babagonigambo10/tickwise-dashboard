import { createClient } from '@supabase/supabase-js'

// Same pattern as save-credentials.js / check-credentials.js / stop-bot.js /
// force-stop-bot.js -- service role key, server-side only.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '')
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ detail: 'Unauthorized' })
  const userId = userData.user.id

  try {
    const orchestratorRes = await fetch(`${ORCHESTRATOR_URL}/internal/kill-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': INTERNAL_API_TOKEN,
      },
      body: JSON.stringify({ user_id: userId }),
    })
    const body = await orchestratorRes.json().catch(() => ({}))
    if (!orchestratorRes.ok) {
      return res.status(orchestratorRes.status).json({ detail: body.detail || 'Cancel failed' })
    }
    return res.status(200).json(body)
  } catch (e) {
    return res.status(502).json({ detail: `Could not reach the orchestrator: ${e.message}` })
  }
}
