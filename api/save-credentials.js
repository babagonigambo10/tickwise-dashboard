import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Server-side Supabase client using the service role key — bypasses RLS.
// This file runs on Vercel, never in the browser, so this key stays private.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// AES-256-GCM encryption using the same key family as the orchestrator.
// ENCRYPTION_KEY here must be a 32-byte key, base64-encoded.
function encrypt(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Layout: nonce(12) + ciphertext + tag(16) — matches Python's AESGCM convention
  // so the orchestrator (Python) can decrypt what this endpoint (Node) encrypts.
  return Buffer.concat([iv, encrypted, authTag])
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '')
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !userData?.user) return res.status(401).json({ detail: 'Unauthorized' })
  const userId = userData.user.id

  const { api_key, secret_key } = req.body || {}
  if (!api_key || !secret_key) return res.status(400).json({ detail: 'Missing api_key or secret_key' })

  const { error } = await supabaseAdmin.from('api_credentials').upsert({
    user_id: userId,
    encrypted_api_key: encrypt(api_key),
    encrypted_secret_key: encrypt(secret_key),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  if (error) return res.status(500).json({ detail: error.message })
  return res.status(200).json({ ok: true })
}
