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
      if (stdDev < 0.005) { // Reduced from 0.01 to 0.005
        setSignalQuality('disconnected');
        setBpm(null);
        return;
      }
      
      // Check if signal is extremely noisy (poor connection)
      if (stdDev > 5.0) { // Increased from 3.5 to 5.0
        setSignalQuality('poor');
        return;
      }
      
      // Check for saturation (all values near min/max)
      const nearMax = recent.filter(v => Math.abs(v) > 3.0).length; // Increased from 2.5 to 3.0
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
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,w,h);
    
    // draw grid lines
    ctx.strokeStyle = 'rgba(0,255,255,0.08)'; ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const y = (i / 7) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    
    // draw midline
    ctx.strokeStyle = 'rgba(0,255,255,0.15)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

    const samples = samplesRef.current; // Lead II (A1)
    if (samples.length < 2) {
      // show "waiting for data" message
      ctx.fillStyle = '#888'; ctx.font = '14px Inter, Arial'; ctx.textAlign = 'center';
      if (calibrating) {
        ctx.fillText('🔄 Calibrating ECG (5 seconds)...', w/2, h/2 - 20);
        ctx.fillStyle = '#aaa'; ctx.font = '12px Inter, Arial';
        ctx.fillText('Keep sensor stable', w/2, h/2 + 10);
      } else {
        ctx.fillText('Waiting for ECG data...', w/2, h/2 - 20);
        ctx.fillStyle = '#aaa'; ctx.font = '12px Inter, Arial';
        ctx.fillText('Connect your device or click Demo Mode', w/2, h/2 + 10);
      }
      return;
    }
    
    // Draw Lead II (A1) - primary waveform with vibrant red glow effect
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ff0064';
    ctx.strokeStyle = '#ff0064'; 
    ctx.lineWidth = 2.5; 
    ctx.beginPath();
    const view = samples.slice(-MAX_SAMPLES);
    const minV = -2.0; const maxV = 2.0; // normalized range after calibration
    for (let i = 0; i < view.length; i++) {
      const x = (i / (view.length - 1)) * w;
      const v = view[i];
      const y = h/2 - (v / (maxV - minV)) * h * 0.85;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Label
    ctx.fillStyle = '#ff0064'; ctx.font = 'bold 13px Inter, Arial'; ctx.textAlign = 'left';
    ctx.shadowBlur = 5;
    ctx.shadowColor = '#ff0064';
    ctx.fillText('Lead II (A1)', 14, 24);
    ctx.shadowBlur = 0;
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
              <stop offset="0%" stopColor="#00ff9d" />
              <stop offset="50%" stopColor="#ffc800" />
              <stop offset="100%" stopColor="#ff0064" />
            </linearGradient>
          </defs>
          
          {/* Background circle */}
          <circle cx={cx} cy={cy} r={r} stroke="rgba(255,255,255,0.05)" strokeWidth="18" fill="none" />
          
          {/* Colored progress arc */}
          {value && (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              stroke={clamped < 60 ? '#00ff9d' : clamped < 100 ? '#ffc800' : '#ff0064'}
              strokeWidth="18"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * r * pct} ${2 * Math.PI * r}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                filter: `drop-shadow(0 0 12px ${clamped < 60 ? '#00ff9d' : clamped < 100 ? '#ffc800' : '#ff0064'})`,
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
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
            )
          })}
        </svg>

        <div style={{position:'absolute',left:0,top:0,width:220,height:220,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:48,fontWeight:800,color: clamped < 60 ? '#00ff9d' : clamped < 100 ? '#ffc800' : '#ff0064', letterSpacing:'-2px',textShadow:'0 0 20px '+(clamped < 60 ? 'rgba(0,255,157,0.6)' : clamped < 100 ? 'rgba(255,200,0,0.6)' : 'rgba(255,0,100,0.6)')}}>{value ? value : '--'}</div>
            <div style={{fontSize:13,color:'#888',letterSpacing:'2px',marginTop:-4}}>BPM</div>
          </div>
        </div>

        {/* Debug panel */}
        <div className="glass" style={{
          position: 'absolute',
          bottom: '20px',
          right: '20px',
          padding: '12px 16px',
          borderRadius: '10px',
          fontSize: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          fontWeight: 500
        }}>
          <div>Signal: <span style={{color: signalQuality === 'good' ? '#00ff9d' : signalQuality === 'poor' ? '#ffc800' : '#ff0064', fontWeight: 700, textShadow: '0 0 10px '+(signalQuality === 'good' ? 'rgba(0,255,157,0.5)' : signalQuality === 'poor' ? 'rgba(255,200,0,0.5)' : 'rgba(255,0,100,0.5)')}}>{signalQuality}</span></div>
          <div>Samples: <span style={{color: '#00ffff', fontWeight: 600}}>{samplesRef.current.length}</span></div>
          <div>StdDev: <span style={{color: '#ff00ff', fontWeight: 600}}>{(() => {
            const samples = samplesRef.current;
            if (samples.length < 50) return 'N/A';
            const recent = samples.slice(-100);
            const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
            const variance = recent.reduce((a,b) => a + Math.pow(b - avg, 2), 0) / recent.length;
            return Math.sqrt(variance).toFixed(3);
          })()}</span></div>
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
              <stop offset="0%" stopColor="#00ff9d" />
              <stop offset="50%" stopColor="#ffc800" />
              <stop offset="100%" stopColor="#ff0064" />
            </linearGradient>
          </defs>
          {/* Background arc with glow */}
          <path d={`M ${cx + r*Math.cos(-120*Math.PI/180)} ${cy + r*Math.sin(-120*Math.PI/180)} A ${r} ${r} 0 0 1 ${cx + r*Math.cos(120*Math.PI/180)} ${cy + r*Math.sin(120*Math.PI/180)}`} stroke="url(#hg)" strokeWidth="12" fill="none" strokeLinecap="round" style={{filter:'drop-shadow(0 0 8px rgba(0,255,255,0.4))'}} />
          
          {/* Labels */}
          <text x={20} y={85} fill="#00ff9d" fontSize="10" fontWeight="700" style={{textShadow:'0 0 5px rgba(0,255,157,0.5)'}}>Normal</text>
          <text x={cx-20} y={25} fill="#ffc800" fontSize="10" fontWeight="700" style={{textShadow:'0 0 5px rgba(255,200,0,0.5)'}}>Moderate</text>
          <text x={100} y={85} fill="#ff0064" fontSize="10" fontWeight="700" style={{textShadow:'0 0 5px rgba(255,0,100,0.5)'}}>High</text>
          
          {/* Arrow needle */}
          <g transform={`translate(${cx},${cy}) rotate(${angle})`}>
            <polygon points="0,-45 -3,-38 3,-38" fill="#00ffff" stroke="#000" strokeWidth="1" />
            <rect x={-2} y={-38} width={4} height={38} rx={2} fill="#00ffff" stroke="#000" strokeWidth="1" style={{filter:'drop-shadow(0 0 6px rgba(0,255,255,0.8))'}} />
            <circle cx={0} cy={0} r={5} fill="#0a0a0a" stroke="#00ffff" strokeWidth={2} style={{filter:'drop-shadow(0 0 8px rgba(0,255,255,0.6))'}} />
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
        console.log('📡 Calibration complete. Starting signal quality check...');
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
            
            // Advanced R-peak detection on Lead II - Works for both demo and real ECG
            if (!calibrating && samplesRef.current.length > 30) {
              if (!monitoringActive) {
                // Log once every 100 samples when waiting for monitoring to activate
                if (samplesRef.current.length % 100 === 0) {
                  console.log('📊 Receiving data... Samples:', samplesRef.current.length, '| Monitoring:', monitoringActive);
                }
              } else {
                // Monitoring is active - detect R-peaks using improved algorithm
                const windowSize = 30;
                const recent = samplesRef.current.slice(-windowSize);
                
                // Calculate statistics for adaptive threshold
                const max = Math.max(...recent);
                const min = Math.min(...recent);
                const range = max - min;
                const avg = recent.reduce((a,b)=>a+b,0) / recent.length;
                const stdDev = Math.sqrt(recent.reduce((a,b)=>a+Math.pow(b-avg,2),0)/recent.length);
                
                // Only proceed if we have meaningful signal variance
                if (stdDev > 0.01 && range > 0.05) {
                  const current = val2;
                  const prev1 = samplesRef.current[samplesRef.current.length - 2];
                  const prev2 = samplesRef.current[samplesRef.current.length - 3];
                  
                  // Multi-criteria peak detection:
                  // 1. Adaptive threshold based on signal statistics
                  const adaptiveThreshold = avg + stdDev * 1.2;
                  
                  // 2. Peak must be in upper 30% of signal range
                  const upperThreshold = min + range * 0.7;
                  
                  // 3. Detect peak: local maximum (higher than neighbors) AND above thresholds
                  const isPeak = current > prev1 && prev1 >= prev2 && 
                                 current > adaptiveThreshold && 
                                 current > upperThreshold;
                  
                  if (isPeak) {
                    const now = Date.now();
                    const timeSinceLastBeat = now - lastBeatTime.current;
                    
                    // Refractory period: 300ms minimum, 2000ms maximum (30-200 BPM range)
                    if (timeSinceLastBeat > 300 && timeSinceLastBeat < 2000) {
                      console.log('❤️ R-peak detected! Value:', current.toFixed(3), 'Threshold:', adaptiveThreshold.toFixed(3), 'Range:', range.toFixed(3));
                      
                      beatsRef.current.push(now);
                      if (beatsRef.current.length > 50) {
                        beatsRef.current.splice(0, beatsRef.current.length - 50);
                      }
                      
                      // Calculate BPM from recent beats (use 3-8 beats for stability)
                      if (beatsRef.current.length >= 3) {
                        // Use adaptive window: more beats = more stable
                        const numBeats = Math.min(8, beatsRef.current.length);
                        const recentBeats = beatsRef.current.slice(-numBeats);
                        
                        let totalIBI = 0;
                        for (let i = 1; i < recentBeats.length; i++) {
                          totalIBI += recentBeats[i] - recentBeats[i-1];
                        }
                        const avgIBI = totalIBI / (recentBeats.length - 1);
                        const newBpm = Math.round(60000 / avgIBI);
                        
                        console.log('💓 BPM calculated:', newBpm, 'from', recentBeats.length, 'beats, avgIBI:', avgIBI.toFixed(0), 'ms');
                        
                        // Validate BPM range (30-200 is physiologically reasonable)
                        if (newBpm >= 30 && newBpm <= 200) {
                          setBpm(newBpm);
                        } else {
                          console.warn('⚠️ BPM out of range:', newBpm, '- ignoring');
                        }
                      }
                      
                      lastBeatTime.current = now;
                      
                      // Update threshold based on detected peak (adaptive learning)
                      peakThreshold.current = current * 0.7;
                    } else if (timeSinceLastBeat <= 300) {
                      // Too soon - likely T-wave or noise
                      console.log('🔇 Peak ignored (refractory period):', timeSinceLastBeat, 'ms');
                    }
                  }
                } else {
                  // Signal too flat - log periodically
                  if (samplesRef.current.length % 200 === 0) {
                    console.log('⚠️ Signal variance too low. StdDev:', stdDev.toFixed(4), 'Range:', range.toFixed(4));
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
    
    // Check signal for 3 seconds (reduced from 7)
    const checkDuration = 3000;
    const checkInterval = 100;
    const steps = checkDuration / checkInterval;
    
    for (let i = 0; i <= steps; i++) {
      setSignalCheckProgress((i / steps) * 100);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    // After 3 seconds, check if signal is good
    const samples = samplesRef.current;
    if (samples.length < 50) {
      console.warn('Not enough data received yet, will retry...');
      setCheckingSignal(false);
      // Auto-enable monitoring anyway to start detecting
      setMonitoringActive(true);
      return;
    }
    
    const recent = samples.slice(-100);
    const avg = recent.reduce((a,b) => a+b, 0) / recent.length;
    const variance = recent.reduce((a,b) => a + Math.pow(b - avg, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev < 0.01) {
      console.warn('Signal too weak - but will try monitoring anyway');
      setCheckingSignal(false);
      setMonitoringActive(true); // Try monitoring anyway
      return;
    }
    
    if (stdDev > 4.5) { // Increased tolerance from 3.5 to 4.5
      console.warn('Signal noisy - but will try monitoring anyway');
      setCheckingSignal(false);
      setMonitoringActive(true); // Try monitoring anyway
      return;
    }
    
    // Signal is good - start monitoring
    console.log('✅ Signal Quality Good! Heart rate monitoring active.');
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
    <div style={{fontFamily:'Inter,Arial,Helvetica,sans-serif',color:'#f5f5f5',minHeight:'100vh',padding:20}}>
      {/* Header with glassmorphism */}
      <div className="glass-strong" style={{display:'flex',alignItems:'center',gap:20,marginBottom:16,padding:'20px 28px',borderRadius:16,boxShadow:'0 20px 60px rgba(0,0,0,0.8), 0 0 40px rgba(0,255,255,0.15)'}}>
        <div style={{fontSize:48,filter:'drop-shadow(0 4px 12px rgba(255,0,255,0.6))'}}>🫀</div>
        <div style={{flex:1}}>
          <h1 style={{
            margin:0,
            background:'linear-gradient(135deg, #00ffff 0%, #ff00ff 50%, #00ff9d 100%)',
            WebkitBackgroundClip:'text',
            WebkitTextFillColor:'transparent',
            backgroundClip:'text',
            fontSize:32,
            fontWeight:800,
            letterSpacing:'-1.5px',
            filter:'drop-shadow(0 0 20px rgba(0,255,255,0.3))'
          }}>
            How's My Heart
          </h1>
          <div style={{fontSize:13,color:'#aaa',marginTop:6,letterSpacing:'0.5px',fontWeight:500}}>
            Professional ECG Monitoring & Analysis System
          </div>
        </div>
      </div>

      <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center',flexWrap:'wrap'}}>
        {port ? (
          <>
            <button onClick={disconnectSerial}>🔌 Disconnect</button>
            {!monitoringActive && !checkingSignal && (
              <button onClick={startSignalCheck} style={{background:'rgba(0, 255, 157, 0.15)', borderColor:'rgba(0, 255, 157, 0.6)', color:'#00ff9d'}}>
                ▶ Start Monitoring
              </button>
            )}
            {checkingSignal && (
              <div className="glass" style={{display:'flex',alignItems:'center',gap:12,padding:'10px 18px',borderRadius:10}}>
                <div style={{fontSize:14,color:'#00ffff',fontWeight:500}}>Initializing...</div>
                <div style={{width:140,height:8,background:'rgba(0,0,0,0.5)',borderRadius:4,overflow:'hidden',border:'1px solid rgba(0,255,255,0.3)'}}>
                  <div style={{width:`${signalCheckProgress}%`,height:'100%',background:'linear-gradient(90deg, #00ffff, #ff00ff)',transition:'width 0.1s linear',boxShadow:'0 0 15px rgba(0,255,255,0.6)'}} />
                </div>
                <div style={{fontSize:12,color:'#00ffff',fontWeight:600}}>{Math.round(signalCheckProgress)}%</div>
              </div>
            )}
            {monitoringActive && (
              <div className="glass" style={{display:'flex',alignItems:'center',gap:10,padding:'10px 18px',borderRadius:10,background:'rgba(0, 255, 157, 0.1)',border:'2px solid rgba(0, 255, 157, 0.5)'}}>
                <div style={{width:10,height:10,borderRadius:'50%',background:'#00ff9d',animation:'pulse 1.5s ease-in-out infinite',boxShadow:'0 0 10px rgba(0,255,157,0.8)'}}></div>
                <div style={{fontSize:14,color:'#00ff9d',fontWeight:600,textShadow:'0 0 10px rgba(0,255,157,0.5)'}}>Monitoring Active</div>
              </div>
            )}
          </>
        ) : (
          <button onClick={connectSerial} disabled={demoMode}>🔌 Connect Device</button>
        )}
        <button onClick={toggleDemo} style={{background: demoMode ? 'rgba(0, 255, 157, 0.15)' : '', borderColor: demoMode ? 'rgba(0, 255, 157, 0.6)' : '', color: demoMode ? '#00ff9d' : ''}}>
          {demoMode ? '⏹ Stop Demo' : '▶ Demo Mode'}
        </button>
      </div>

      <div style={{display:'flex',gap:20,marginTop:16,alignItems:'flex-start'}}>
        <div style={{flex:1}}>
          {/* Signal Quality Warning */}
          {signalQuality === 'disconnected' && (
            <div className="glass" style={{background:'rgba(255,0,100,0.15)',padding:12,borderRadius:12,marginBottom:12,display:'flex',alignItems:'center',gap:12,border:'2px solid rgba(255,0,100,0.5)',boxShadow:'0 8px 24px rgba(255,0,100,0.3), 0 0 30px rgba(255,0,100,0.2)'}}>
              <span style={{fontSize:24}}>⚠️</span>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:'#ff0064'}}>Leads Disconnected</div>
                <div style={{fontSize:11,color:'#f5f5f5',marginTop:2}}>Please check electrode connections</div>
              </div>
            </div>
          )}
          {signalQuality === 'poor' && (
            <div className="glass" style={{background:'rgba(255,200,0,0.15)',padding:12,borderRadius:12,marginBottom:12,display:'flex',alignItems:'center',gap:12,border:'2px solid rgba(255,200,0,0.5)',boxShadow:'0 8px 24px rgba(255,200,0,0.3), 0 0 30px rgba(255,200,0,0.2)'}}>
              <span style={{fontSize:24}}>⚡</span>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:'#ffc800'}}>Poor Signal Quality</div>
                <div style={{fontSize:11,color:'#f5f5f5',marginTop:2}}>Check connections or reduce movement</div>
              </div>
            </div>
          )}
          
          <div style={{display:'flex',gap:16,alignItems:'stretch'}}>
            <div style={{flex:1}}>
              <canvas ref={canvasRef} style={{width:'100%',minHeight:'280px',border:'2px solid rgba(0,255,255,0.3)',background:'#0a0a0a',borderRadius:12,boxShadow:'inset 0 2px 10px rgba(0,0,0,0.8), 0 8px 32px rgba(0,0,0,0.6), 0 0 30px rgba(0,255,255,0.1)'}} />
            </div>
            <div style={{width:200,display:'flex',flexDirection:'column',gap:16}}>
              {/* Heart Rate Gauge Block */}
              <div className="glass-strong" style={{padding:18,borderRadius:14,display:'flex',flexDirection:'column',alignItems:'center',gap:10,boxShadow:'0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,255,255,0.15)'}}>
                <Gauge value={monitoringActive ? bpm : null} />
                <div style={{textAlign:'center',marginTop:8}}>
                  <div style={{fontSize:13,color:'#aaa',marginBottom:6,fontWeight:500}}>Heart Rate</div>
                  {checkingSignal && <span style={{color:'#00ffff',fontSize:11,fontWeight:600}}>🔍 Checking...</span>}
                  {calibrating && <span style={{color:'#ffc800',fontSize:11,fontWeight:600}}>🔄 Calibrating...</span>}
                  {demoMode && !calibrating && <span style={{color:'#00ff9d',fontSize:11,fontWeight:600}}>● Demo Mode</span>}
                  {port && !demoMode && !calibrating && !checkingSignal && monitoringActive && <span style={{color:'#00ff9d',fontSize:11,fontWeight:600}}>● Monitoring</span>}
                  {port && !demoMode && !calibrating && !checkingSignal && !monitoringActive && <span style={{color:'#aaa',fontSize:11,fontWeight:600}}>⏸ Waiting</span>}
                  {!port && !demoMode && <span style={{color:'#aaa',fontSize:11,fontWeight:600}}>○ Not Connected</span>}
                </div>
              </div>

              {/* Sample Counter Block */}
              <div className="glass-strong" style={{padding:14,borderRadius:14,textAlign:'center',boxShadow:'0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(255,0,255,0.15)'}}>
                <div style={{fontSize:11,color:'#aaa',marginBottom:6,fontWeight:600,letterSpacing:'0.5px'}}>DATA SAMPLES</div>
                <div style={{fontSize:26,fontWeight:800,color:'#ff00ff',letterSpacing:'-1px',textShadow:'0 0 20px rgba(255,0,255,0.5)'}}>{samplesRef.current.length}</div>
                {signalQuality === 'good' && <div style={{fontSize:10,color:'#00ff9d',marginTop:6,fontWeight:600}}>✓ Good Signal</div>}
                {signalQuality === 'poor' && <div style={{fontSize:10,color:'#ffc800',marginTop:6,fontWeight:600}}>⚡ Noisy</div>}
                {signalQuality === 'disconnected' && <div style={{fontSize:10,color:'#ff0064',marginTop:6,fontWeight:600}}>⚠ No Leads</div>}
              </div>

              {/* 3D Heart Block */}
              <div className="glass-strong" style={{padding:14,borderRadius:14,display:'flex',flexDirection:'column',alignItems:'center',gap:10,boxShadow:'0 8px 32px rgba(0,0,0,0.6), 0 0 20px rgba(0,255,157,0.15)'}}>
                <Heart3D bpm={bpm} />
                <div style={{fontSize:11,color:'#aaa',fontWeight:500}}>Live Pulse</div>
              </div>
            </div>
          </div>
        </div>

        {/* Heart Health Index - only show if monitoring is active and signal is good */}
        {monitoringActive && signalQuality === 'good' && (
          <div className="glass-strong" style={{width:280,padding:18,borderRadius:14,color:'#f5f5f5',boxShadow:'0 12px 40px rgba(0,0,0,0.7), 0 0 40px rgba(0,255,255,0.15)'}}>
            <h3 style={{marginTop:0,marginBottom:12,color:'#fff',fontSize:17,fontWeight:700}}>Heart Health Index</h3>
            
            {/* Health Gauge */}
            <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>
              <HealthGauge score={healthCategory.score} />
            </div>
            
            <div style={{fontSize:20,fontWeight:800,textAlign:'center',color: healthCategory.level==='High'?'#ff0064': healthCategory.level==='Moderate'?'#ffc800':'#00ff9d',letterSpacing:'-0.5px',textShadow:'0 0 20px '+(healthCategory.level==='High'?'rgba(255,0,100,0.5)': healthCategory.level==='Moderate'?'rgba(255,200,0,0.5)':'rgba(0,255,157,0.5)')}}>{healthCategory.level}</div>
            <div style={{marginTop:8,color:'#ccc',textAlign:'center',fontSize:12,lineHeight:1.5}}>{healthCategory.desc}</div>
            
            <div style={{marginTop:12,padding:14,background:'rgba(0,0,0,0.5)',borderRadius:10,border:'1px solid rgba(0,255,255,0.2)'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#fff',marginBottom:10}}>Score Breakdown</div>
              <div style={{marginTop:10}}>
                <div className="small" style={{color:'#aaa',marginBottom:4,fontWeight:500,fontSize:11}}>Heart rate contribution</div>
                <div style={{height:8,background:'rgba(0,0,0,0.8)',borderRadius:6,overflow:'hidden',border:'1px solid rgba(255,200,0,0.2)'}}>
                  <div style={{width:`${breakdown.brady + breakdown.tachy}%`,height:'100%',background:'linear-gradient(90deg, #ffc800, #ff9500)',boxShadow:'0 0 15px rgba(255,200,0,0.5)'}} />
                </div>
                <div style={{marginTop:8}} className="small">
                  <span style={{color:'#aaa',fontWeight:500,fontSize:11}}>Rhythm irregularity</span>
                </div>
                <div style={{height:8,background:'rgba(0,0,0,0.8)',borderRadius:6,overflow:'hidden',marginTop:4,border:'1px solid rgba(255,0,100,0.2)'}}>
                  <div style={{width:`${breakdown.irregularity}%`,height:'100%',background:'linear-gradient(90deg, #ff0064, #ff0095)',boxShadow:'0 0 15px rgba(255,0,100,0.5)'}} />
                </div>
                <div style={{marginTop:10,fontSize:10,color:'#ccc',display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:4}}>
                  <div><strong>Brady:</strong> {breakdown.brady}</div>
                  <div><strong>Tachy:</strong> {breakdown.tachy}</div>
                  <div><strong>Irregular:</strong> {breakdown.irregularity}</div>
                </div>
              </div>
            </div>
            
            <div style={{marginTop:12}}>
              <button onClick={() => setShowHealthInfo(s => !s)} style={{width:'100%',fontSize:12,padding:'8px 14px'}}>{showHealthInfo ? 'Hide Info' : 'What is this?'}</button>
              {showHealthInfo && (
                <div className="glass" style={{marginTop:10,padding:12,fontSize:11,lineHeight:1.6,color:'#ccc',borderRadius:10}}>
                  <strong style={{color:'#fff'}}>Heart Health Index</strong> combines heart rate (BPM) and rhythm irregularity into a simple score.
                  <ul style={{marginTop:6,marginBottom:0,paddingLeft:18,fontSize:10}}>
                    <li>Bradycardia and tachycardia increase the score</li>
                    <li>High beat-to-beat variability increases the score</li>
                    <li>This is a screening aid only, not diagnostic</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Medical Professional Section */}
      <div className="glass-strong" style={{marginTop:20,padding:20,borderRadius:16,display:'flex',gap:20,alignItems:'center',boxShadow:'0 12px 40px rgba(0,0,0,0.7), 0 0 40px rgba(255,0,255,0.15)'}}>
        <div style={{fontSize:70,filter:'drop-shadow(0 8px 20px rgba(0,255,255,0.6))'}}>
          👨‍⚕️
        </div>
        
        <div style={{flex:1}}>
          <h3 style={{margin:0,color:'#00ffff',fontSize:18,fontWeight:800,marginBottom:10,letterSpacing:'-0.5px',textShadow:'0 0 20px rgba(0,255,255,0.5)'}}>
            💡 Medical Guidance
          </h3>
          <div style={{color:'#ccc',fontSize:13,lineHeight:1.6}}>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#ff00ff',fontWeight:600}}>📡 Connection:</strong> Connect Arduino (115200 baud) with Web Serial API (Chrome/Edge).
            </div>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#00ff9d',fontWeight:600}}>🔬 Health Index:</strong> Screening tool combining heart rate and rhythm irregularity.
            </div>
            <div className="glass" style={{padding:12,background:'rgba(255,0,100,0.15)',borderLeft:'3px solid #ff0064',borderRadius:8,marginTop:10,border:'2px solid rgba(255,0,100,0.3)',boxShadow:'0 0 20px rgba(255,0,100,0.2)'}}>
              <strong style={{color:'#ff0064',fontWeight:700}}>⚠️ Important:</strong> <span style={{color:'#f5f5f5'}}>For irregular rhythm or high Health Index scores, consult a doctor for proper diagnosis.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
