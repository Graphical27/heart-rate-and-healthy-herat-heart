import React, { useRef, useState, useEffect } from 'react'

// Helper to split text stream by newlines
class LineBreakTransformer {
  constructor() { this.container = '' }
  transform(chunk, controller) {
    this.container += chunk;
    const lines = this.container.split('\n');
    this.container = lines.pop();
    for (const line of lines) controller.enqueue(line);
  }
  flush(controller) {
    if (this.container) controller.enqueue(this.container);
  }
}

function computeStats(arr) {
  if (!arr || arr.length === 0) return {mean:0,sd:0};
  const mean = arr.reduce((a,b) => a+b,0)/arr.length;
  const sd = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/arr.length);
  return {mean,sd};
}

export default function App() {
  const canvasRef = useRef(null);
  const [port, setPort] = useState(null);
  const [bpm, setBpm] = useState(null);
  const [healthCategory, setHealthCategory] = useState({level:'--',score:0,desc:''});
  const [showHealthInfo, setShowHealthInfo] = useState(false);
  const [breakdown, setBreakdown] = useState({brady:0,tachy:0,irregularity:0});
  const [demoMode, setDemoMode] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [signalQuality, setSignalQuality] = useState('unknown');
  const [checkingSignal, setCheckingSignal] = useState(false);
  const [signalCheckProgress, setSignalCheckProgress] = useState(0);
  const [monitoringActive, setMonitoringActive] = useState(false); // 'good', 'poor', 'disconnected', 'unknown'
  const samplesRef = useRef([]); // Lead II (A1) samples - circular buffer
  const samples2Ref = useRef([]); // Lead I (A0) samples - circular buffer
  const beatsRef = useRef([]); // timestamps (ms) of heart beats (from bpm messages)
  const MAX_SAMPLES = 1500; // ~12 seconds at 125 Hz
  const lastBeatTime = useRef(0);
  const peakThreshold = useRef(0.3); // Dynamic threshold for R-peak detection

  useEffect(() => {
    let anim = true;
    const render = () => {
      if (!anim) return;
      drawCanvas();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return () => { anim = false };
  }, []);

  // Demo mode effect - generate fake ECG data
  useEffect(() => {
    if (!demoMode) return;
    
    let t = 0;
    const interval = setInterval(() => {
      // Generate synthetic ECG-like waveform
      const val = 0.6 * Math.sin(2*Math.PI*1.2*t) + 0.2*Math.sin(2*Math.PI*20*t) + (Math.sin(2*Math.PI*0.25*t)*0.3);
      // Add R-peak spikes
      const spike = (Math.sin(2*Math.PI*1.2*t) > 0.95) ? 1.2 : 0;
      const sample = val + spike;
      
      samplesRef.current.push(sample);
      samples2Ref.current.push(sample * 0.8); // slightly different for Lead I
      if (samplesRef.current.length > MAX_SAMPLES) {
        samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES);
        samples2Ref.current.splice(0, samples2Ref.current.length - MAX_SAMPLES);
      }
      
      // Detect R-peaks and compute BPM
      if (spike > 0.5) {
        const now = Date.now();
        if (now - lastBeatTime.current > 300) { // refractory period
          beatsRef.current.push(now);
          if (beatsRef.current.length > 50) {
            beatsRef.current.splice(0, beatsRef.current.length - 50);
          }
          if (beatsRef.current.length >= 2) {
            const ibi = now - beatsRef.current[beatsRef.current.length - 2];
            const demoBpm = Math.round(60000 / ibi);
            setBpm(demoBpm);
          }
          lastBeatTime.current = now;
        }
      }
      
      t += 0.008; // 125 Hz
    }, 8);
    
    return () => clearInterval(interval);
  }, [demoMode]);

  useEffect(() => {
    // whenever beatsRef updates (we push in serial loop), recompute rhythm metrics
    const compute = () => {
      const beats = beatsRef.current;
      if (beats.length < 3) return setHealthCategory({level:'Insufficient data', score:0, desc:'Need at least 3 beats to assess rhythm.'});

      // compute inter-beat intervals (ms)
      const ibis = [];
      for (let i=1;i<beats.length;i++) ibis.push(beats[i] - beats[i-1]);
      // use last 8 IBIs
      const last = ibis.slice(-8);
      const {mean, sd} = computeStats(last);
      const cv = mean > 0 ? sd / mean : 0; // coefficient of variation

      // derive a simple irregularity metric (0..1)
      const irregularity = Math.min(1, cv * 3.0); // scale factor

      // heart rate rules
      const hr = bpm || Math.round(60000 / mean);

      // Health index scoring (higher is worse)
      let bradyScore = 0;
      let tachyScore = 0;
      // bradycardia
      if (hr < 50) bradyScore = 40;
      else if (hr < 60) bradyScore = 20;
      // tachycardia
      if (hr > 120) tachyScore = 40;
      else if (hr > 100) tachyScore = 20;
      // irregular rhythm contribution (0..40)
      const irrScore = Math.round(irregularity * 40);

      // total
      let score = bradyScore + tachyScore + irrScore;
      score = Math.max(0, Math.min(100, score));

      let level = 'Normal';
      let desc = 'Heart rate and rhythm are within typical ranges.';
      if (score >= 70) { level = 'High'; desc = 'High concern: heart rate or rhythm suggest elevated risk — seek medical attention if symptomatic.' }
      else if (score >= 35) { level = 'Moderate'; desc = 'Moderate concern: some abnormal findings. Consider monitoring and consulting a clinician.' }

      setBreakdown({brady: bradyScore, tachy: tachyScore, irregularity: irrScore});
      setHealthCategory({level, score, desc});
    };

    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [bpm]);

  // Signal quality monitor
  useEffect(() => {
    if (!port && !demoMode) {
      setSignalQuality('unknown');
      return;
    }
    
    const checkQuality = () => {
      const samples = samplesRef.current;
      if (samples.length < 50) {
        setSignalQuality('unknown');
        return;
      }
      
      // Check last 100 samples
      const recent = samples.slice(-100);
      const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
      const variance = recent.reduce((a,b) => a + Math.pow(b - avg, 2), 0) / recent.length;
      const stdDev = Math.sqrt(variance);
      
      // More lenient checks
      // Check if signal is too flat (disconnected leads)
      if (stdDev < 0.01) {
        setSignalQuality('disconnected');
        setBpm(null);
        return;
      }
      
      // Check if signal is extremely noisy (poor connection)
      if (stdDev > 3.5) {
        setSignalQuality('poor');
        return;
      }
      
      // Check for saturation (all values near min/max)
      const nearMax = recent.filter(v => Math.abs(v) > 2.5).length;
      if (nearMax > recent.length * 0.9) {
        setSignalQuality('disconnected');
        setBpm(null);
        return;
      }
      
      // Default to good if we have data coming in
      setSignalQuality('good');
    };
    
    const id = setInterval(checkQuality, 1000);
    return () => clearInterval(id);
  }, [port, demoMode]);

  function drawCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth;
    const h = canvas.height = 320;
    ctx.fillStyle = '#0d1218'; ctx.fillRect(0,0,w,h);
    // draw grid lines
    ctx.strokeStyle = '#1a2530'; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const y = (i / 7) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // draw midline
    ctx.strokeStyle = '#2a3540'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

    const samples = samplesRef.current; // Lead II (A1)
    if (samples.length < 2) {
      // show "waiting for data" message
      ctx.fillStyle = '#555'; ctx.font = '14px Arial'; ctx.textAlign = 'center';
      if (calibrating) {
        ctx.fillText('🔄 Calibrating ECG (5 seconds)...', w/2, h/2 - 20);
        ctx.fillStyle = '#777'; ctx.font = '12px Arial';
        ctx.fillText('Keep sensor stable', w/2, h/2 + 10);
      } else {
        ctx.fillText('Waiting for ECG data...', w/2, h/2 - 20);
        ctx.fillStyle = '#777'; ctx.font = '12px Arial';
        ctx.fillText('Connect your device or click Demo Mode', w/2, h/2 + 10);
      }
      return;
    }
    
    // Draw Lead II (A1) - primary waveform
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 3; ctx.beginPath();
    const view = samples.slice(-MAX_SAMPLES);
    const minV = -2.0; const maxV = 2.0; // normalized range after calibration
    for (let i = 0; i < view.length; i++) {
      const x = (i / (view.length - 1)) * w;
      const v = view[i];
      const y = h/2 - (v / (maxV - minV)) * h * 0.85;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // Label
    ctx.fillStyle = '#ff4444'; ctx.font = 'bold 13px Arial'; ctx.textAlign = 'left';
    ctx.fillText('Lead II (A1)', 10, 22);
  }

  // Gauge rendering (modern arc style without needle)
  function Gauge({value}) {
    const min = 30; const max = 180;
    const clamped = Math.max(min, Math.min(max, value || 60));
    const pct = (clamped - min) / (max - min);
    const cx = 110; const cy = 110; const r = 85;

    return (
      <div style={{width:220,height:220,position:'relative'}}>
        <svg width={220} height={220} viewBox="0 0 220 220">
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4ade80" />
              <stop offset="50%" stopColor="#facc15" />
              <stop offset="100%" stopColor="#ef4444" />
            </linearGradient>
          </defs>
          
          {/* Background circle */}
          <circle cx={cx} cy={cy} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="18" fill="none" />
          
          {/* Colored progress arc */}
          {value && (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              stroke={clamped < 60 ? '#4ade80' : clamped < 100 ? '#facc15' : '#ef4444'}
              strokeWidth="18"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * r * pct} ${2 * Math.PI * r}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                filter: `drop-shadow(0 0 8px ${clamped < 60 ? '#4ade8060' : clamped < 100 ? '#facc1560' : '#ef444460'})`,
                transition: 'all 0.3s ease'
              }}
            />
          )}
          
          {/* Tick marks */}
          {[40, 60, 80, 100, 120, 140, 160].map((v,i)=>{
            const p = (v - min) / (max - min);
            const angle = -90 + p*360;
            const a = angle * Math.PI/180;
            const x1 = cx + (r-12)*Math.cos(a);
            const y1 = cy + (r-12)*Math.sin(a);
            const x2 = cx + (r-4)*Math.cos(a);
            const y2 = cy + (r-4)*Math.sin(a);
            return (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#666" strokeWidth={2} />
            )
          })}
        </svg>

        <div style={{position:'absolute',left:0,top:0,width:220,height:220,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:48,fontWeight:800,color: clamped < 60 ? '#4ade80' : clamped < 100 ? '#facc15' : '#ef4444', letterSpacing:'-2px'}}>{value ? value : '--'}</div>
            <div style={{fontSize:13,color:'#888',letterSpacing:'2px',marginTop:-4}}>BPM</div>
          </div>
        </div>

        {/* Debug panel */}
        <div style={{
          position: 'absolute',
          bottom: '20px',
          right: '20px',
          padding: '10px 15px',
          background: 'rgba(0,0,0,0.6)',
          borderRadius: '8px',
          fontSize: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '5px'
        }}>
          <div>Signal: <span style={{color: signalQuality === 'good' ? '#0f0' : signalQuality === 'poor' ? '#ff0' : '#f00'}}>{signalQuality}</span></div>
          <div>Samples: {samplesRef.current.length}</div>
          <div>StdDev: {(() => {
            const samples = samplesRef.current;
            if (samples.length < 50) return 'N/A';
            const recent = samples.slice(-100);
            const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
            const variance = recent.reduce((a,b) => a + Math.pow(b - avg, 2), 0) / recent.length;
            return Math.sqrt(variance).toFixed(3);
          })()}</div>
        </div>
      </div>
    );
  }

  // Health Index Arrow Gauge
  function HealthGauge({score}) {
    const cx = 70; const cy = 70; const r = 50;
    const angle = -120 + (score / 100) * 240; // -120 to 120 degrees
    
    return (
      <div style={{width:140,height:100,position:'relative'}}>
        <svg width={140} height={100} viewBox="0 0 140 100">
          <defs>
            <linearGradient id="hg" x1="0" x2="1">
              <stop offset="0%" stopColor="#7ef77e" />
              <stop offset="50%" stopColor="#ffb020" />
              <stop offset="100%" stopColor="#ff6b6b" />
            </linearGradient>
          </defs>
          {/* Background arc */}
          <path d={`M ${cx + r*Math.cos(-120*Math.PI/180)} ${cy + r*Math.sin(-120*Math.PI/180)} A ${r} ${r} 0 0 1 ${cx + r*Math.cos(120*Math.PI/180)} ${cy + r*Math.sin(120*Math.PI/180)}`} stroke="url(#hg)" strokeWidth="12" fill="none" strokeLinecap="round" />
          
          {/* Labels */}
          <text x={20} y={85} fill="#7ef77e" fontSize="10" fontWeight="600">Normal</text>
          <text x={cx-20} y={25} fill="#ffb020" fontSize="10" fontWeight="600">Moderate</text>
          <text x={100} y={85} fill="#ff6b6b" fontSize="10" fontWeight="600">High</text>
          
          {/* Arrow needle */}
          <g transform={`translate(${cx},${cy}) rotate(${angle})`}>
            <polygon points="0,-45 -3,-38 3,-38" fill="#fff" stroke="#000" strokeWidth="1" />
            <rect x={-2} y={-38} width={4} height={38} rx={2} fill="#fff" stroke="#000" strokeWidth="1" />
            <circle cx={0} cy={0} r={5} fill="#1a1f28" stroke="#fff" strokeWidth={2} />
          </g>
        </svg>
        
        <div style={{position:'absolute',left:0,top:0,width:140,height:100,display:'flex',alignItems:'flex-end',justifyContent:'center',pointerEvents:'none'}}>
          <div style={{fontSize:18,fontWeight:700,color:'#fff',marginBottom:8}}>{score}</div>
        </div>
      </div>
    )
  }

  async function connectSerial() {
    if (!('serial' in navigator)) {
      alert('Web Serial API not supported in this browser. Use Chrome/Edge and enable experimental features.');
      return;
    }
    try {
      const requestedPort = await navigator.serial.requestPort();
      await requestedPort.open({ baudRate: 115200 });
      setPort(requestedPort);
      setCalibrating(true);
      setMonitoringActive(false); // Monitoring disabled initially

      // Auto start signal check after connection
      setTimeout(() => {
        setCalibrating(false);
        startSignalCheck();
      }, 1000);

      // setup text stream
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = requestedPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .getReader();

      // read loop
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        
        const line = value.trim();
        
        // Detect calibration messages
        if (line.includes('Calibration') || line.includes('Starting') || line.includes('Baseline') || line.includes('Gain')) {
          console.log('Arduino:', line);
          if (line.includes('Complete')) {
            setCalibrating(false);
          }
          continue;
        }
        
        // Parse comma-separated values: value1,value2
        const parts = line.split(',');
        if (parts.length >= 2) {
          const val1 = parseFloat(parts[0]); // Lead I (A0)
          const val2 = parseFloat(parts[1]); // Lead II (A1)
          
          if (!isNaN(val1) && !isNaN(val2)) {
            // Store Lead II (A1) as primary
            samplesRef.current.push(val2);
            samples2Ref.current.push(val1);
            
            if (samplesRef.current.length > MAX_SAMPLES) {
              samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES);
              samples2Ref.current.splice(0, samples2Ref.current.length - MAX_SAMPLES);
            }
            
            // Simple R-peak detection on Lead II
            if (!calibrating && samplesRef.current.length > 10 && monitoringActive) {
              const recent = samplesRef.current.slice(-10);
              const avg = recent.reduce((a,b)=>a+b,0) / recent.length;
              const stdDev = Math.sqrt(recent.reduce((a,b)=>a+Math.pow(b-avg,2),0)/recent.length);
              
              // Only detect peaks if signal quality is reasonable
              if (stdDev > 0.05 && stdDev < 2.0) {
                const current = val2;
                
                // Detect peak crossing threshold
                if (current > peakThreshold.current && current > avg * 1.5) {
                  const now = Date.now();
                  if (now - lastBeatTime.current > 300) { // 300ms refractory
                    beatsRef.current.push(now);
                    if (beatsRef.current.length > 50) {
                      beatsRef.current.splice(0, beatsRef.current.length - 50);
                    }
                    
                    // Calculate BPM from last 2 beats
                    if (beatsRef.current.length >= 2) {
                      const ibi = now - beatsRef.current[beatsRef.current.length - 2];
                      const newBpm = Math.round(60000 / ibi);
                      if (newBpm >= 40 && newBpm <= 200) {
                        setBpm(newBpm);
                      }
                    }
                    lastBeatTime.current = now;
                    
                    // Adapt threshold
                    peakThreshold.current = current * 0.6;
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Serial connect error', err);
      setCalibrating(false);
    }
  }

  async function disconnectSerial() {
    if (!port) return;
    try {
      await port.close();
    } catch(e){}
    setPort(null);
    setCalibrating(false);
    setCheckingSignal(false);
    setSignalCheckProgress(0);
    setMonitoringActive(false);
    setBpm(null);
  }

  async function startSignalCheck() {
    setCheckingSignal(true);
    setSignalCheckProgress(0);
    
    // Check signal for 7 seconds
    const checkDuration = 7000;
    const checkInterval = 100;
    const steps = checkDuration / checkInterval;
    
    for (let i = 0; i <= steps; i++) {
      setSignalCheckProgress((i / steps) * 100);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    // After 7 seconds, check if signal is good
    const samples = samplesRef.current;
    if (samples.length < 50) {
      alert('⚠️ Not enough data received. Please check connection and try reconnecting.');
      setCheckingSignal(false);
      setMonitoringActive(false);
      return;
    }
    
    const recent = samples.slice(-100);
    const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
    const variance = recent.reduce((a,b) => a + Math.pow(b - avg, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev < 0.01) {
      alert('❌ Signal too weak - leads may be disconnected. Please check electrode connections.');
      setCheckingSignal(false);
      setMonitoringActive(false);
      return;
    }
    
    if (stdDev > 3.5) {
      alert('⚡ Signal too noisy - check electrode connections and reduce movement.');
      setCheckingSignal(false);
      setMonitoringActive(false);
      return;
    }
    
    // Signal is good - start monitoring
    alert('✅ Signal Quality Good! Starting heart rate monitoring...');
    setCheckingSignal(false);
    setSignalCheckProgress(0);
    setMonitoringActive(true); // Enable BPM and Health Index calculations
  }

  async function checkSignalQuality() {
    startSignalCheck();
  }

  function toggleDemo() {
    if (demoMode) {
      // stop demo
      setDemoMode(false);
      samplesRef.current = [];
      samples2Ref.current = [];
      beatsRef.current = [];
      setBpm(null);
      setMonitoringActive(false);
    } else {
      // start demo
      if (port) {
        alert('Please disconnect from device first');
        return;
      }
      setDemoMode(true);
      setMonitoringActive(true); // Enable monitoring in demo mode
    }
  }

  function Heart3D({bpm}) {
    // Realistic 3D beating heart with CSS 3D transforms
    const rate = bpm && bpm > 0 ? (60 / bpm) : 1.0; // seconds per beat
    return (
      <div style={{width:140,height:140,perspective:600,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div className="heart-container" style={{'--beat-duration': `${rate}s`}}>
          <div className="heart-3d">
            {/* Front face */}
            <div className="heart-face heart-front">
              <svg viewBox="0 0 100 100" style={{width:'100%',height:'100%'}}>
                <defs>
                  <linearGradient id="hg1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff6b8a" />
                    <stop offset="100%" stopColor="#d62859" />
                  </linearGradient>
                  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000" floodOpacity="0.4" />
                  </filter>
                </defs>
                <path filter="url(#shadow)" d="M50,30 C35,10, 10,15, 10,35 C10,55, 30,75, 50,95 C70,75, 90,55, 90,35 C90,15, 65,10, 50,30 Z" fill="url(#hg1)" />
              </svg>
            </div>
            {/* Back face (darker) */}
            <div className="heart-face heart-back">
              <svg viewBox="0 0 100 100" style={{width:'100%',height:'100%'}}>
                <path d="M50,30 C35,10, 10,15, 10,35 C10,55, 30,75, 50,95 C70,75, 90,55, 90,35 C90,15, 65,10, 50,30 Z" fill="#a02050" />
              </svg>
            </div>
            {/* Left side */}
            <div className="heart-face heart-left">
              <div style={{width:'100%',height:'100%',background:'linear-gradient(90deg, #c04060, #d62859)'}} />
            </div>
            {/* Right side */}
            <div className="heart-face heart-right">
              <div style={{width:'100%',height:'100%',background:'linear-gradient(90deg, #d62859, #c04060)'}} />
            </div>
            {/* Top */}
            <div className="heart-face heart-top">
              <div style={{width:'100%',height:'100%',background:'#d62859'}} />
            </div>
            {/* Bottom */}
            <div className="heart-face heart-bottom">
              <div style={{width:'100%',height:'100%',background:'#a02050'}} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{fontFamily:'Arial,Helvetica,sans-serif',color:'#eee',minHeight:'100vh',padding:20}}>
      {/* Header with 3D professional design */}
      <div style={{display:'flex',alignItems:'center',gap:15,marginBottom:20,background:'linear-gradient(135deg, rgba(30,30,30,0.6), rgba(20,20,20,0.4))',padding:'20px 30px',borderRadius:12,border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 8px 32px rgba(0,0,0,0.4)'}}>
        <div style={{fontSize:56,filter:'drop-shadow(0 4px 8px rgba(239,68,68,0.3))'}}>🫀</div>
        <div style={{flex:1}}>
          <h1 style={{
            margin:0,
            background:'linear-gradient(135deg, #60a5fa 0%, #a78bfa 50%, #ec4899 100%)',
            WebkitBackgroundClip:'text',
            WebkitTextFillColor:'transparent',
            backgroundClip:'text',
            fontSize:36,
            fontWeight:800,
            letterSpacing:'-1px',
            filter:'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'
          }}>
            How's My Heart
          </h1>
          <div style={{fontSize:14,color:'#888',marginTop:6,letterSpacing:'0.5px'}}>
            ⚕️ Professional ECG Monitoring & Analysis System
          </div>
        </div>
        <div style={{display:'flex',gap:15,fontSize:32,opacity:0.7}}>
          <span title="Heart Monitor" style={{filter:'drop-shadow(0 2px 4px rgba(239,68,68,0.3))'}}>💓</span>
          <span title="Medical Analysis" style={{filter:'drop-shadow(0 2px 4px rgba(96,165,250,0.3))'}}>🏥</span>
          <span title="Health Check" style={{filter:'drop-shadow(0 2px 4px rgba(167,139,250,0.3))'}}>⚕️</span>
        </div>
      </div>

      <div style={{display:'flex',gap:10,marginBottom:20,alignItems:'center'}}>
        {port ? (
          <>
            <button onClick={disconnectSerial}>🔌 Disconnect</button>
            {checkingSignal && (
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 16px',background:'rgba(96, 165, 250, 0.1)',borderRadius:8,border:'1px solid rgba(96, 165, 250, 0.3)'}}>
                <div style={{fontSize:14,color:'#60a5fa'}}>Checking signal quality...</div>
                <div style={{width:120,height:8,background:'rgba(0,0,0,0.3)',borderRadius:4,overflow:'hidden'}}>
                  <div style={{width:`${signalCheckProgress}%`,height:'100%',background:'linear-gradient(90deg, #60a5fa, #a78bfa)',transition:'width 0.1s linear'}} />
                </div>
                <div style={{fontSize:12,color:'#888'}}>{Math.round(signalCheckProgress)}%</div>
              </div>
            )}
          </>
        ) : (
          <button onClick={connectSerial} disabled={demoMode}>🔌 Connect Device</button>
        )}
        <button onClick={toggleDemo} style={{background: demoMode ? 'rgba(126, 247, 126, 0.15)' : ''}}>
          {demoMode ? '⏹ Stop Demo' : '▶ Demo Mode'}
        </button>
      </div>

      <div style={{display:'flex',gap:20,marginTop:20,alignItems:'flex-start'}}>
        <div style={{flex:1}}>
          {/* Signal Quality Warning */}
          {signalQuality === 'disconnected' && (
            <div style={{background:'linear-gradient(135deg,#ff6b6b,#ee5a6f)',padding:12,borderRadius:6,marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
              <span style={{fontSize:24}}>⚠️</span>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>Leads Disconnected!</div>
                <div style={{fontSize:12,opacity:0.9}}>Please check electrode connections</div>
              </div>
            </div>
          )}
          {signalQuality === 'poor' && (
            <div style={{background:'linear-gradient(135deg,#ffb020,#ff9500)',padding:12,borderRadius:6,marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
              <span style={{fontSize:24}}>⚡</span>
              <div>
                <div style={{fontWeight:700,fontSize:14}}>Poor Signal Quality</div>
                <div style={{fontSize:12,opacity:0.9}}>Check connections or reduce movement</div>
              </div>
            </div>
          )}
          
          <div style={{display:'flex',gap:12,alignItems:'stretch'}}>
            <div style={{flex:1}}>
              <canvas ref={canvasRef} style={{width:'100%',minHeight:'320px',border:'1px solid #2a3540',background:'#0d1218',borderRadius:6,boxShadow:'0 6px 18px rgba(0,0,0,0.5)'}} />
            </div>
            <div style={{width:180,display:'flex',flexDirection:'column',gap:12}}>
              {/* Heart Rate Gauge Block */}
              <div style={{background:'linear-gradient(180deg,rgba(30,30,30,0.8),rgba(20,20,20,0.9))',padding:16,borderRadius:8,border:'1px solid #2a3540',display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
                <Gauge value={monitoringActive ? bpm : null} />
                <div style={{textAlign:'center',marginTop:8}}>
                  <div style={{fontSize:14,color:'#aaa',marginBottom:4}}>Current Heart Rate</div>
                  {checkingSignal && <span style={{color:'#60a5fa',fontSize:11}}>🔍 Checking Signal...</span>}
                  {calibrating && <span style={{color:'#ffb020',fontSize:11}}>🔄 Calibrating...</span>}
                  {demoMode && !calibrating && <span style={{color:'#7ef77e',fontSize:11}}>● Demo Mode</span>}
                  {port && !demoMode && !calibrating && !checkingSignal && monitoringActive && <span style={{color:'#7ef77e',fontSize:11}}>● Monitoring Active</span>}
                  {port && !demoMode && !calibrating && !checkingSignal && !monitoringActive && <span style={{color:'#888',fontSize:11}}>⏸ Waiting for Signal Check</span>}
                  {!port && !demoMode && <span style={{color:'#888',fontSize:11}}>○ Not connected</span>}
                </div>
              </div>

              {/* Sample Counter Block */}
              <div style={{background:'linear-gradient(180deg,rgba(30,30,30,0.8),rgba(20,20,20,0.9))',padding:12,borderRadius:8,border:'1px solid #2a3540',textAlign:'center'}}>
                <div style={{fontSize:11,color:'#888',marginBottom:4}}>DATA SAMPLES</div>
                <div style={{fontSize:24,fontWeight:700,color:'#ff4444'}}>{samplesRef.current.length}</div>
                {signalQuality === 'good' && <div style={{fontSize:10,color:'#7ef77e',marginTop:4}}>✓ Good Signal</div>}
                {signalQuality === 'poor' && <div style={{fontSize:10,color:'#ffb020',marginTop:4}}>⚡ Noisy</div>}
                {signalQuality === 'disconnected' && <div style={{fontSize:10,color:'#ff6b6b',marginTop:4}}>⚠ No Leads</div>}
              </div>

              {/* 3D Heart Block */}
              <div style={{background:'linear-gradient(180deg,rgba(30,30,30,0.8),rgba(20,20,20,0.9))',padding:12,borderRadius:8,border:'1px solid #2a3540',display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
                <Heart3D bpm={bpm} />
                <div style={{fontSize:11,color:'#888'}}>Live Pulse</div>
              </div>
            </div>
          </div>
        </div>

        {/* Heart Health Index - only show if monitoring is active and signal is good */}
        {monitoringActive && signalQuality === 'good' && (
          <div style={{width:360,background:'linear-gradient(180deg,#1a2332,#151e2b)',padding:16,borderRadius:8,border:'1px solid #2a3540',color:'#eee',boxShadow:'0 8px 20px rgba(0,0,0,0.4)'}}>
            <h3 style={{marginTop:0,color:'#fff'}}>Heart Health Index</h3>
            
            {/* Health Gauge */}
            <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>
              <HealthGauge score={healthCategory.score} />
            </div>
            
            <div style={{fontSize:22,fontWeight:700,textAlign:'center',color: healthCategory.level==='High'?'#ff6b6b': healthCategory.level==='Moderate'?'#ffb020':'#7ef77e'}}>{healthCategory.level}</div>
            <div style={{marginTop:8,color:'#bbb',textAlign:'center'}}>{healthCategory.desc}</div>
            <div style={{marginTop:12}}>
              <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>Why this score?</div>
              <div style={{marginTop:8}}>
                <div className="small" style={{color:'#aaa'}}>Heart rate contribution</div>
                <div style={{height:10,background:'#1e2836',borderRadius:6,overflow:'hidden'}}>
                  <div style={{width:`${breakdown.brady + breakdown.tachy}%`,height:'100%',background:'#ffb020'}} />
                </div>
                <div style={{marginTop:6,color:'#aaa'}} className="small">Rhythm irregularity contribution</div>
                <div style={{height:10,background:'#1e2836',borderRadius:6,overflow:'hidden'}}>
                  <div style={{width:`${breakdown.irregularity}%`,height:'100%',background:'#ff6b6b'}} />
                </div>
                <div style={{marginTop:8,fontSize:13,color:'#ccc'}}>
                  <div><strong>Brady:</strong> {breakdown.brady} pts &middot; <strong>Tachy:</strong> {breakdown.tachy} pts</div>
                  <div><strong>Irregularity:</strong> {breakdown.irregularity} pts</div>
                </div>
              </div>
            </div>
            <div style={{marginTop:12}}>
              <button onClick={() => setShowHealthInfo(s => !s)}>{showHealthInfo ? 'Hide' : 'What is this?'}</button>
              {showHealthInfo && (
                <div style={{marginTop:10,color:'#bbb',fontSize:13}}>
                  <strong>Heart Health Index</strong> combines heart rate (BPM) and rhythm irregularity (variability of inter-beat intervals) into a simple score:
                  <ul>
                    <li>Low HR (bradycardia) and very high HR (tachycardia) increase the score (worse).</li>
                    <li>High beat-to-beat variability (irregular rhythm) increases the score.</li>
                    <li>Categories: Normal &middot; Moderate &middot; High. This is a screening aid only, not diagnostic.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Medical Professional Section */}
      <div style={{marginTop:24,background:'linear-gradient(135deg, rgba(30,30,30,0.6), rgba(20,20,20,0.4))',padding:24,borderRadius:12,border:'1px solid rgba(255,255,255,0.1)',boxShadow:'0 8px 32px rgba(0,0,0,0.4)',display:'flex',gap:24,alignItems:'center'}}>
        {/* 3D Doctor Icon */}
        <div style={{fontSize:120,filter:'drop-shadow(0 8px 16px rgba(96,165,250,0.3))'}}>
          👨‍⚕️
        </div>
        
        <div style={{flex:1}}>
          <h3 style={{margin:0,color:'#60a5fa',fontSize:22,fontWeight:700,marginBottom:12}}>
            💡 Medical Guidance
          </h3>
          <div style={{color:'#bbb',fontSize:14,lineHeight:1.6}}>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#a78bfa'}}>📡 Connection:</strong> Connect your Arduino (baud 115200) streaming comma-separated ECG data via Web Serial API (Chrome/Edge recommended).
            </div>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#ec4899'}}>🔬 Heart Health Index:</strong> This is a screening tool combining heart rate and rhythm irregularity. Categories: Normal • Moderate • High risk.
            </div>
            <div style={{padding:12,background:'rgba(239,68,68,0.1)',borderLeft:'3px solid #ef4444',borderRadius:4,marginTop:12}}>
              <strong style={{color:'#fca5a5'}}>⚠️ Important:</strong> BPM readings are accurate. If you notice irregular rhythm patterns or high Health Index scores, please consult a doctor immediately for proper diagnosis.
            </div>
          </div>
        </div>
        
        {/* Additional medical icons */}
        <div style={{display:'flex',flexDirection:'column',gap:12,fontSize:48,opacity:0.6}}>
          <span style={{filter:'drop-shadow(0 4px 8px rgba(239,68,68,0.3))'}}>🩺</span>
          <span style={{filter:'drop-shadow(0 4px 8px rgba(96,165,250,0.3))'}}>💊</span>
          <span style={{filter:'drop-shadow(0 4px 8px rgba(167,139,250,0.3))'}}>📋</span>
        </div>
      </div>
    </div>
  )
}
