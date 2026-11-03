import { createClient, createAccount, generatePrivateKey } from 'genlayer-js'
import { studionet } from 'genlayer-js/chains'
import { TransactionStatus } from 'genlayer-js/types'

export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || ''
export const RPC_URL = 'https://studio.genlayer.com/api'
export const CHAIN_ID = 61999
export const CHAIN_ID_HEX = '0xF22F'
export const EXPLORER_ADDRESS = (addr) =>
  `https://explorer-studio.genlayer.com/address/${addr}`

function readClient() {
  return createClient({ chain: studionet, endpoint: RPC_URL })
}

let reviewerAccount = null
export function getReviewerAccount() {
  if (!reviewerAccount) {
    reviewerAccount = createAccount(generatePrivateKey())
  }
  return reviewerAccount
}

function writeClient() {
  return createClient({
    chain: studionet,
    endpoint: RPC_URL,
    account: getReviewerAccount(),
  })
}

export function shortAddr(addr) {
  if (!addr) return ''
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

export function shortHash(hash) {
  if (!hash) return ''
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash
}

// ---- reads (no wallet needed) ----

function parseJson(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

export async function fetchProfile(username) {
  const raw = await readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName: 'get_profile',
    args: [username],
  })
  return parseJson(raw)
}

export async function fetchClaim(id) {
  const raw = await readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName: 'get_claim',
    args: [id],
  })
  return parseJson(raw)
}

export async function fetchClaimCount() {
  const raw = await readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName: 'get_claim_count',
    args: [],
  })
  return Number(raw)
}

export async function fetchClaims() {
  const count = await fetchClaimCount()
  if (count === 0) return []
  const start = Math.max(0, count - 20)
  const raw = await readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName: 'list_claims',
    args: [start, Math.min(20, count - start)],
  })
  const list = parseJson(raw)
  return list.slice().reverse()
}

// ---- wallet connect (any injected EIP-1193 wallet) ----

export function hasInjectedWallet() {
  return typeof window !== 'undefined' && !!window.ethereum
}

export async function connectInjectedWallet() {
  if (!hasInjectedWallet()) {
    throw new Error('NO_WALLET')
  }
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  if (!accounts || accounts.length === 0) {
    throw new Error('NO_ACCOUNTS')
  }
  const address = accounts[0]
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' })
  if (chainHex && parseInt(chainHex, 16) !== CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }],
      })
    } catch (switchErr) {
      if (switchErr && switchErr.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: CHAIN_ID_HEX,
              chainName: 'GenLayer Stable Studionet',
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
              blockExplorerUrls: ['https://explorer-studio.genlayer.com'],
            },
          ],
        })
      } else {
        throw new Error('WRONG_CHAIN')
      }
    }
  }
  return address
}

// ---- writes (reviewer test account, clearly labelled in the UI) ----

export async function waitFinalized(hash, onStatus) {
  const client = writeClient()
  let lastStatus = ''
  const poller = setInterval(async () => {
    try {
      const tx = await client.getTransaction({ hash })
      const name = tx.statusName || String(tx.status ?? '')
      if (name && name !== lastStatus) {
        lastStatus = name
        if (onStatus) onStatus(name)
      }
    } catch {
      // Polling is best-effort; the receipt wait below is authoritative.
    }
  }, 3000)
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      status: TransactionStatus.FINALIZED,
      retries: 180,
      interval: 5000,
    })
    return receipt
  } finally {
    clearInterval(poller)
  }
}

export async function submitClaim(username, repo, note) {
  const hash = await writeClient().writeContract({
    address: CONTRACT_ADDRESS,
    functionName: 'claim_contribution',
    args: [username, repo, note],
    value: 0n,
    leaderOnly: false,
  })
  return hash
}

export async function submitVerify(claimId) {
  const hash = await writeClient().writeContract({
    address: CONTRACT_ADDRESS,
    functionName: 'verify_contribution',
    args: [BigInt(claimId)],
    value: 0n,
    leaderOnly: false,
  })
  return hash
}

// Human-readable error mapping. Contract EXPECTED codes become plain
// language; anything else becomes a generic message with the tx hash
// for follow-up. Raw errors are never shown.
export function friendlyError(err) {
  const msg = String((err && err.message) || err || '')
  if (msg.includes('NO_WALLET')) return 'NO_WALLET'
  if (msg.includes('NO_ACCOUNTS')) return 'NO_ACCOUNTS'
  if (msg.includes('WRONG_CHAIN')) return 'WRONG_CHAIN'
  if (msg.includes('username_length')) return 'USERNAME_LENGTH'
  if (msg.includes('username_format')) return 'USERNAME_FORMAT'
  if (msg.includes('repo_format')) return 'REPO_FORMAT'
  if (msg.includes('note_length')) return 'NOTE_LENGTH'
  if (msg.includes('claim_cap_reached')) return 'CAP_REACHED'
  if (msg.includes('duplicate_claim')) return 'DUPLICATE_CLAIM'
  if (msg.includes('claim_not_pending')) return 'NOT_PENDING'
  if (msg.includes('claim_not_found')) return 'NOT_FOUND'
  if (msg.includes('User rejected') || msg.includes('user rejected')) return 'REJECTED'
  return 'GENERIC'
}
