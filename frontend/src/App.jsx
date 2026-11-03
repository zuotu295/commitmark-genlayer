import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CONTRACT_ADDRESS,
  EXPLORER_ADDRESS,
  connectInjectedWallet,
  fetchClaim,
  fetchClaimCount,
  fetchClaims,
  fetchProfile,
  friendlyError,
  getReviewerAccount,
  hasInjectedWallet,
  shortAddr,
  shortHash,
  submitClaim,
  submitVerify,
  waitFinalized,
} from './genlayer.js'
import { STRINGS, badgeLabelFor } from './i18n.js'
import {
  installFirstClickAutoEnable,
  isSoundOn,
  playChime,
  setSoundOn,
  subscribe,
} from './sound.js'

const REPO_URL = (repo) => `https://github.com/${repo}`

function statusClass(status) {
  if (status === 'verified') return 'stamp verified'
  if (status === 'refuted') return 'stamp refuted'
  return 'stamp pending'
}

function statusLabel(status, t) {
  if (status === 'verified') return t.statusVerified
  if (status === 'refuted') return t.statusRefuted
  return t.statusPending
}

function txLabel(name, t) {
  if (name === 'ACCEPTED') return t.statusAccepted
  if (name === 'FINALIZED') return t.statusFinalized
  if (name === 'SUBMITTED') return t.statusSubmitted
  return name
}

function validUsername(v) {
  if (v.length < 1 || v.length > 39) return 'USERNAME_LENGTH'
  if (v.startsWith('-') || v.endsWith('-')) return 'USERNAME_FORMAT'
  if (!/^[A-Za-z0-9-]+$/.test(v)) return 'USERNAME_FORMAT'
  return null
}

function validRepo(v) {
  const parts = v.split('/')
  if (parts.length !== 2) return 'REPO_FORMAT'
  for (const part of parts) {
    if (part.length < 1 || !/^[A-Za-z0-9._-]+$/.test(part)) return 'REPO_FORMAT'
  }
  return null
}

export default function App() {
  const [lang, setLang] = useState('en')
  const t = STRINGS[lang]
  const [sound, setSound] = useState(isSoundOn())
  const [splash, setSplash] = useState(true)
  const [splashGone, setSplashGone] = useState(false)
  const [walletAddr, setWalletAddr] = useState('')
  const [walletError, setWalletError] = useState('')
  const [reviewerAddr, setReviewerAddr] = useState(() => {
    try {
      return getReviewerAccount().address
    } catch {
      return ''
    }
  })

  const [searchName, setSearchName] = useState('')
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [timeline, setTimeline] = useState([])

  const [claims, setClaims] = useState([])
  const [streamLoading, setStreamLoading] = useState(false)
  const [streamError, setStreamError] = useState('')

  const [cUsername, setCUsername] = useState('')
  const [cRepo, setCRepo] = useState('')
  const [cNote, setCNote] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimTx, setClaimTx] = useState(null)
  const [claimError, setClaimError] = useState('')
  const [createdClaim, setCreatedClaim] = useState(null)
  const [claimNotice, setClaimNotice] = useState('')

  const [verifyingId, setVerifyingId] = useState(null)
  const [verifyTx, setVerifyTx] = useState(null)
  const [verifyError, setVerifyError] = useState('')
  const [verifyNotice, setVerifyNotice] = useState('')

  const glowRef = useRef(null)
  const finePointer = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(pointer: fine)').matches,
    [],
  )
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const errText = (code) => {
    const map = {
      NO_WALLET: t.errNoWallet,
      NO_ACCOUNTS: t.errNoAccounts,
      WRONG_CHAIN: t.errWrongChain,
      USERNAME_LENGTH: t.errUsernameLength,
      USERNAME_FORMAT: t.errUsernameFormat,
      REPO_FORMAT: t.errRepoFormat,
      NOTE_LENGTH: t.errNoteLength,
      CAP_REACHED: t.errCap,
      DUPLICATE_CLAIM: t.errDuplicate,
      NOT_PENDING: t.errNotPending,
      NOT_FOUND: t.errNotFound,
      REJECTED: t.errRejected,
      GENERIC: t.errGeneric,
    }
    return map[code] || t.errGeneric
  }

  // Splash: fade out on a timer, or immediately on click.
  useEffect(() => {
    installFirstClickAutoEnable()
    const unsub = subscribe((on) => setSound(on))
    const ms = reducedMotion ? 250 : 1500
    const timer = setTimeout(() => setSplash(false), ms)
    const gone = setTimeout(() => setSplashGone(true), ms + 750)
    return () => {
      unsub()
      clearTimeout(timer)
      clearTimeout(gone)
    }
  }, [reducedMotion])

  // Scroll reveal for everything marked .reveal, including content
  // that arrives later from chain reads.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12 },
    )
    document.querySelectorAll('.reveal:not(.observed)').forEach((el) => {
      el.classList.add('observed')
      observer.observe(el)
    })
    return () => observer.disconnect()
  })

  // Cursor glow on fine pointers only.
  useEffect(() => {
    if (!finePointer) return undefined
    const move = (event) => {
      if (glowRef.current) {
        glowRef.current.style.background = `radial-gradient(340px circle at ${event.clientX}px ${event.clientY}px, rgba(255,197,61,0.09), transparent 70%)`
      }
    }
    window.addEventListener('mousemove', move)
    return () => window.removeEventListener('mousemove', move)
  }, [finePointer])

  const refreshStream = async () => {
    if (!CONTRACT_ADDRESS) return
    setStreamLoading(true)
    setStreamError('')
    try {
      const list = await fetchClaims()
      setClaims(list)
    } catch (e) {
      setStreamError(errText(friendlyError(e)))
    } finally {
      setStreamLoading(false)
    }
  }

  useEffect(() => {
    refreshStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTilt = (event) => {
    if (!finePointer || reducedMotion) return
    const el = event.currentTarget
    const rect = el.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width - 0.5
    const y = (event.clientY - rect.top) / rect.height - 0.5
    el.style.transform = `perspective(700px) rotateY(${x * 4}deg) rotateX(${y * -4}deg)`
  }

  const resetTilt = (event) => {
    event.currentTarget.style.transform = ''
  }

  const doSearch = async (event) => {
    event.preventDefault()
    const name = searchName.trim()
    if (!name) return
    if (!CONTRACT_ADDRESS) {
      setProfileError(t.notConfigured)
      return
    }
    setProfileLoading(true)
    setProfileError('')
    try {
      const [prof, list] = await Promise.all([fetchProfile(name), fetchClaims()])
      setProfile(prof)
      setTimeline(
        list.filter((c) => c.github_username.toLowerCase() === name.toLowerCase()),
      )
    } catch (e) {
      setProfileError(errText(friendlyError(e)))
      setProfile(null)
    } finally {
      setProfileLoading(false)
    }
  }

  const doClaim = async (event) => {
    event.preventDefault()
    const username = cUsername.trim()
    const repo = cRepo.trim()
    const note = cNote.trim()
    const badUser = validUsername(username)
    const badRepo = validRepo(repo)
    if (badUser) {
      setClaimError(errText(badUser))
      return
    }
    if (badRepo) {
      setClaimError(errText(badRepo))
      return
    }
    if (note.length < 2 || note.length > 120) {
      setClaimError(errText('NOTE_LENGTH'))
      return
    }
    if (!CONTRACT_ADDRESS) {
      setClaimError(t.notConfigured)
      return
    }
    setClaimBusy(true)
    setClaimError('')
    setClaimNotice('')
    setCreatedClaim(null)
    try {
      const hash = await submitClaim(username, repo, note)
      setClaimTx({ hash, status: 'SUBMITTED' })
      await waitFinalized(hash, (name) =>
        setClaimTx((prev) => (prev ? { ...prev, status: name } : prev)),
      )
      playChime()
      const count = await fetchClaimCount()
      const record = await fetchClaim(count - 1)
      setCreatedClaim(record)
      setClaimNotice(t.claimCreated)
      refreshStream()
    } catch (e) {
      setClaimError(errText(friendlyError(e)))
    } finally {
      setClaimBusy(false)
    }
  }

  const doVerify = async (claimId) => {
    if (!CONTRACT_ADDRESS) {
      setVerifyError(t.notConfigured)
      return
    }
    setVerifyingId(claimId)
    setVerifyError('')
    setVerifyNotice('')
    try {
      const hash = await submitVerify(claimId)
      setVerifyTx({ hash, status: 'SUBMITTED' })
      await waitFinalized(hash, (name) =>
        setVerifyTx((prev) => (prev ? { ...prev, status: name } : prev)),
      )
      playChime()
      const record = await fetchClaim(claimId)
      setClaims((prev) => prev.map((c) => (c.id === claimId ? record : c)))
      if (profile && record.github_username.toLowerCase() === profile.username.toLowerCase()) {
        setTimeline((prev) => prev.map((c) => (c.id === claimId ? record : c)))
        const prof = await fetchProfile(profile.username)
        setProfile(prof)
      }
      setVerifyNotice(t.verifyDone)
      refreshStream()
    } catch (e) {
      setVerifyError(errText(friendlyError(e)))
    } finally {
      setVerifyingId(null)
    }
  }

  const doConnectWallet = async () => {
    setWalletError('')
    try {
      const addr = await connectInjectedWallet()
      setWalletAddr(addr)
    } catch (e) {
      setWalletError(errText(friendlyError(e)))
    }
  }

  const toggleSound = () => {
    setSoundOn(!sound)
  }

  // Constellation nodes from real chain claims (newest first, capped).
  const nodes = useMemo(() => {
    const items = claims.slice(0, 14)
    return items.map((c, i) => {
      const angle = i * 2.39996
      const radius = 34 + ((i * 23) % 62)
      const cx = 180 + radius * Math.cos(angle) * 2.1
      const cy = 118 + radius * Math.sin(angle) * 0.85
      return { claim: c, cx, cy }
    })
  }, [claims])

  return (
    <div className="page">
      <div ref={glowRef} className="cursor-glow" aria-hidden="true" />
      {!splashGone && (
        <div
          className={`splash ${splash ? '' : 'done'}`}
          onClick={() => setSplash(false)}
          role="button"
          aria-label="Dismiss splash"
        >
          <div className="splash-mark">✦</div>
          <div className="splash-title">{t.splashTitle}</div>
          <div className="splash-sub">{t.splashSub}</div>
        </div>
      )}

      <header className="topbar">
        <div className="brand">
          <img src="./logo.svg" alt="" className="brand-mark" />
          <span className="brand-name">CommitMark</span>
        </div>
        <div className="top-actions">
          <div className="lang-switch" role="group" aria-label="Language">
            <button
              className={lang === 'en' ? 'active' : ''}
              onClick={() => setLang('en')}
            >
              EN
            </button>
            <button
              className={lang === 'zh' ? 'active' : ''}
              onClick={() => setLang('zh')}
            >
              中文
            </button>
          </div>
          <button
            className="icon-btn"
            data-audio-control="true"
            onClick={toggleSound}
            aria-label={sound ? t.soundOn : t.soundOff}
          >
            {sound ? '🔊' : '🔇'}
          </button>
          {walletAddr ? (
            <span className="wallet-pill" title={walletAddr}>
              {t.walletConnected} · {shortAddr(walletAddr)}
            </span>
          ) : (
            <button className="btn small" onClick={doConnectWallet}>
              {t.connectWallet}
            </button>
          )}
        </div>
      </header>
      {walletError && <div className="banner error">{walletError}</div>}
      {!CONTRACT_ADDRESS && <div className="banner warn">{t.notConfigured}</div>}

      <main>
        <section className="hero reveal">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>{t.heroTitle}</h1>
          <p className="hero-sub">{t.heroSub}</p>
          <form className="search-form" onSubmit={doSearch}>
            <label htmlFor="search-name">{t.searchLabel}</label>
            <div className="search-row">
              <input
                id="search-name"
                value={searchName}
                onChange={(e) => setSearchName(e.target.value)}
                placeholder={t.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
              <button className="btn primary" type="submit" disabled={profileLoading}>
                {profileLoading ? t.searching : t.searchButton}
              </button>
            </div>
            <p className="hint">{t.searchHint}</p>
          </form>

          <div className="constellation" aria-hidden="true">
            <svg viewBox="0 0 360 220" preserveAspectRatio="xMidYMid meet">
              {nodes.map(({ claim, cx, cy }) => (
                <g key={claim.id}>
                  <line x1="180" y1="118" x2={cx} y2={cy} className="link" />
                  <circle
                    cx={cx}
                    cy={cy}
                    r="10"
                    className={`halo ${claim.status}`}
                  />
                  <circle cx={cx} cy={cy} r="5" className={`node ${claim.status}`} />
                </g>
              ))}
              <circle cx="180" cy="118" r="9" className="core" />
              {nodes.map(({ claim, cx, cy }) => (
                <text key={`t-${claim.id}`} x={cx} y={cy - 14} className="node-label">
                  {claim.github_username.length > 12
                    ? `${claim.github_username.slice(0, 12)}…`
                    : claim.github_username}
                </text>
              ))}
            </svg>
          </div>
        </section>

        {profileError && <div className="banner error">{profileError}</div>}

        {profile && (
          <section className="profile reveal">
            <div className="profile-head">
              <div>
                <p className="eyebrow">{t.profileTitle}</p>
                <h2 className="mono">{profile.username}</h2>
              </div>
              <div className="score-block">
                <span className="score-num">{profile.score}</span>
                <span className="score-label">{t.scoreLabel}</span>
              </div>
            </div>
            <div className="badges">
              {profile.badges.length === 0 ? (
                <span className="muted">{t.noProfile}</span>
              ) : (
                profile.badges.map((b) => (
                  <span key={b} className="badge">
                    ✦ {badgeLabelFor(b, lang)}
                  </span>
                ))
              )}
            </div>
            <h3>{t.verifiedRepos}</h3>
            {profile.repos.length === 0 ? (
              <p className="muted">{t.empty}</p>
            ) : (
              <ul className="repo-list">
                {profile.repos.map((r) => (
                  <li key={r}>
                    <a href={REPO_URL(r)} target="_blank" rel="noreferrer" className="mono">
                      {r} ↗
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <h3>{t.timelineTitle}</h3>
            {timeline.length === 0 ? (
              <p className="muted">{t.empty}</p>
            ) : (
              <div className="claim-list">
                {timeline.map((c) => (
                  <ClaimCard
                    key={c.id}
                    claim={c}
                    t={t}
                    verifying={verifyingId === c.id}
                    onVerify={() => doVerify(c.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <section
          className="claim-panel reveal tilt"
          onMouseMove={handleTilt}
          onMouseLeave={resetTilt}
        >
          <h2>{t.claimTitle}</h2>
          <p className="muted">{t.claimSub}</p>
          <form onSubmit={doClaim} className="claim-form">
            <label>
              {t.usernameLabel}
              <input
                value={cUsername}
                onChange={(e) => setCUsername(e.target.value)}
                placeholder="torvalds"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              {t.repoLabel}
              <input
                value={cRepo}
                onChange={(e) => setCRepo(e.target.value)}
                placeholder="torvalds/linux"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              {t.noteLabel}
              <input
                value={cNote}
                onChange={(e) => setCNote(e.target.value)}
                placeholder={t.notePlaceholder}
                autoComplete="off"
              />
            </label>
            <button className="btn primary" type="submit" disabled={claimBusy}>
              {claimBusy ? t.submitting : t.submitClaim}
            </button>
          </form>
          {claimError && <div className="banner error">{claimError}</div>}
          {claimTx && (
            <div className="tx-box">
              <span>
                {t.txStatus}: {txLabel(claimTx.status, t)}
              </span>
              <span className="mono">{shortHash(claimTx.hash)}</span>
            </div>
          )}
          {claimNotice && <div className="banner ok">{claimNotice}</div>}
          {createdClaim && (
            <div className="created-claim">
              <ClaimCard
                claim={createdClaim}
                t={t}
                verifying={verifyingId === createdClaim.id}
                onVerify={() => doVerify(createdClaim.id)}
              />
            </div>
          )}
          <div className="reviewer-box">
            <p className="reviewer-line">
              {t.reviewerAddress}:{' '}
              <span className="mono">{reviewerAddr ? shortAddr(reviewerAddr) : '…'}</span>
            </p>
            <p className="reviewer-note">{t.reviewerNote}</p>
          </div>
        </section>

        <section className="stream reveal">
          <h2>{t.streamTitle}</h2>
          <p className="muted">{t.streamSub}</p>
          {streamLoading && <p className="muted">{t.loading}</p>}
          {streamError && <div className="banner error">{streamError}</div>}
          {!streamLoading && claims.length === 0 && !streamError && (
            <p className="muted">{t.noClaims}</p>
          )}
          <div className="claim-list">
            {claims.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                t={t}
                verifying={verifyingId === c.id}
                onVerify={() => doVerify(c.id)}
              />
            ))}
          </div>
          {verifyTx && (
            <div className="tx-box">
              <span>
                {t.txStatus}: {txLabel(verifyTx.status, t)}
              </span>
              <span className="mono">{shortHash(verifyTx.hash)}</span>
            </div>
          )}
          {verifyError && <div className="banner error">{verifyError}</div>}
          {verifyNotice && <div className="banner ok">{verifyNotice}</div>}
        </section>

        <section className="how reveal">
          <h2>{t.howTitle}</h2>
          <div className="steps">
            <div className="step">
              <span className="step-num">01</span>
              <h3>{t.step1Title}</h3>
              <p>{t.step1Text}</p>
            </div>
            <div className="step">
              <span className="step-num">02</span>
              <h3>{t.step2Title}</h3>
              <p>{t.step2Text}</p>
            </div>
            <div className="step">
              <span className="step-num">03</span>
              <h3>{t.step3Title}</h3>
              <p>{t.step3Text}</p>
            </div>
          </div>
        </section>

        <section className="scope reveal">
          <h2>{t.scopeTitle}</h2>
          <p>{t.scopeText}</p>
        </section>
      </main>

      <footer>
        <span>
          {t.footerContract}:{' '}
          <a
            href={EXPLORER_ADDRESS(CONTRACT_ADDRESS)}
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {CONTRACT_ADDRESS ? shortAddr(CONTRACT_ADDRESS) : '—'} ↗
          </a>
        </span>
        <a
          href="https://github.com/zuotu295/commitmark-genlayer/blob/main/evidence.json"
          target="_blank"
          rel="noreferrer"
        >
          {t.footerEvidence} ↗
        </a>
        <a
          href="https://github.com/zuotu295/commitmark-genlayer"
          target="_blank"
          rel="noreferrer"
        >
          {t.footerRepo} ↗
        </a>
      </footer>
    </div>
  )
}

function ClaimCard({ claim, t, verifying, onVerify }) {
  return (
    <article className="claim-card">
      <div className="claim-top">
        <span className="mono claim-user">{claim.github_username}</span>
        <span key={claim.status} className={statusClass(claim.status)}>
          {statusLabel(claim.status, t)}
        </span>
      </div>
      <a
        href={REPO_URL(claim.repo_full_name)}
        target="_blank"
        rel="noreferrer"
        className="mono claim-repo"
      >
        {claim.repo_full_name} ↗
      </a>
      <p className="claim-note">{claim.note}</p>
      <p className="claim-meta">
        {t.claimer}: <span className="mono">{shortAddr(claim.claimer)}</span>
      </p>
      <div className="claim-links">
        <a href={claim.source_url} target="_blank" rel="noreferrer">
          {t.sourceApi} ↗
        </a>
        <a href={REPO_URL(claim.repo_full_name)} target="_blank" rel="noreferrer">
          {t.sourceRepo} ↗
        </a>
        {claim.status === 'pending' && (
          <button className="btn small" onClick={onVerify} disabled={verifying}>
            {verifying ? t.verifying : t.verifyButton}
          </button>
        )}
      </div>
    </article>
  )
}
