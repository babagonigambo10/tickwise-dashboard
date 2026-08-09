import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })

  const token = (req.headers.authorization || '').replace('Bearer ', '')
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ detail: 'Unauthorized' })
  const userId = userData.user.id

  const orchestratorRes = await fetch(`${process.env.ORCHESTRATOR_URL}/internal/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': process.env.INTERNAL_API_TOKEN,
    },
    body: JSON.stringify({ user_id: userId }),
  })

  const body = await orchestratorRes.json().catch(() => ({}))
  return res.status(orchestratorRes.status).json(body)
}
