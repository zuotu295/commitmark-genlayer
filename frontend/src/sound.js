// Ambient workshop hum + FINALIZED chime, user-toggled, never autoplay.
//
// Rules: no sound before a user gesture. The first click anywhere
// except the sound button auto-enables sound (button state synced),
// unless the user manually closed sound before — then it never
// auto-re-enables. The manual-close preference persists in localStorage.
let ctx = null
let ambientNodes = null
let enabled = false
let manuallyClosed = false
let listeners = new Set()

try {
  manuallyClosed = localStorage.getItem('commitmark-sound-closed') === '1'
} catch {
  manuallyClosed = false
}

export function isSoundOn() {
  return enabled
}

export function wasManuallyClosed() {
  return manuallyClosed
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  listeners.forEach((fn) => {
    try {
      fn(enabled)
    } catch {
      // Listener errors must not break audio.
    }
  })
}

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  return ctx
}

function startAmbient() {
  const ac = ensureCtx()
  if (!ac || ambientNodes) return
  const gain = ac.createGain()
  gain.gain.value = 0.0
  gain.connect(ac.destination)
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 320
  filter.connect(gain)
  const osc1 = ac.createOscillator()
  osc1.type = 'sine'
  osc1.frequency.value = 110
  const osc2 = ac.createOscillator()
  osc2.type = 'sine'
  osc2.frequency.value = 164.8
  const gain2 = ac.createGain()
  gain2.gain.value = 0.35
  osc1.connect(filter)
  osc2.connect(gain2)
  gain2.connect(filter)
  osc1.start()
  osc2.start()
  gain.gain.linearRampToValueAtTime(0.035, ac.currentTime + 2.5)
  ambientNodes = { gain, osc1, osc2 }
}

function stopAmbient() {
  if (!ambientNodes || !ctx) return
  const { gain, osc1, osc2 } = ambientNodes
  try {
    gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.4)
    setTimeout(() => {
      try {
        osc1.stop()
        osc2.stop()
      } catch {
        // Already stopped.
      }
    }, 500)
  } catch {
    // Audio teardown must not throw.
  }
  ambientNodes = null
}

export function setSoundOn(on) {
  if (on) {
    ensureCtx()
    enabled = true
    manuallyClosed = false
    try {
      localStorage.removeItem('commitmark-sound-closed')
    } catch {
      // Storage unavailable; the in-memory flag still holds.
    }
    startAmbient()
  } else {
    enabled = false
    manuallyClosed = true
    try {
      localStorage.setItem('commitmark-sound-closed', '1')
    } catch {
      // Storage unavailable; the in-memory flag still holds.
    }
    stopAmbient()
  }
  notify()
}

// First-click auto-enable. Call once at app start. Clicks on the
// sound button itself (marked data-audio-control) do not trigger it.
export function installFirstClickAutoEnable() {
  if (manuallyClosed) return
  const handler = (event) => {
    const target = event.target
    if (target && target.closest && target.closest('[data-audio-control="true"]')) {
      return
    }
    if (!enabled) {
      setSoundOn(true)
    }
    window.removeEventListener('pointerdown', handler)
  }
  window.addEventListener('pointerdown', handler)
}

export function playChime() {
  if (!enabled) return
  const ac = ensureCtx()
  if (!ac) return
  const notes = [659.25, 987.77]
  notes.forEach((freq, i) => {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ac.createGain()
    const start = ac.currentTime + i * 0.14
    gain.gain.setValueAtTime(0.0, start)
    gain.gain.linearRampToValueAtTime(0.12, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(start)
    osc.stop(start + 0.55)
  })
}
