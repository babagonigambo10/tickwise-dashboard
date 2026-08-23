import { createClient } from '@supabase/supabase-js'

// Server-side Supabase client using the service role key — bypasses RLS.
// This file runs on Vercel, never in the browser, so this key stays private.
// Same pattern as save-credentials.js.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// api_credentials has RLS policies for INSERT and UPDATE only — intentionally
// no SELECT policy, since the client should never be able to read encrypted
// keys back out. That means the dashboard can't just query the table
// directly to check "does this user have credentials saved?" -- that query
// gets silently blocked by RLS and always looks like zero rows.
// This endpoint exists purely to answer that yes/no question from the
// server side (service role bypasses RLS), without ever exposing the
// encrypted_api_key / encrypted_secret_key columns to the browser.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '')
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ detail: 'Unauthorized' })
  const userId = userData.user.id

  const exchangeId = String(req.query.exchange || 'mexc').toLowerCase()

  const { count, error } = await supabaseAdmin
    .from('api_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('exchange', exchangeId)

  if (error) return res.status(500).json({ detail: error.message })
  return res.status(200).json({ hasCreds: (count ?? 0) > 0 })
}
