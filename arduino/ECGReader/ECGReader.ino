// ECGReader.ino
// Simple ECG reader for Arduino reading analog pin A1.
// Samples at ~500 Hz, removes DC, smooths, detects R-peaks with a simple adaptive threshold,
// computes BPM and streams samples & BPM over Serial as JSON lines.

const int ECG_PIN = A1; // analog pin A1
const unsigned long SAMPLE_INTERVAL_US = 2000UL; // 500 Hz -> 2000 microseconds

unsigned long lastSampleMicros = 0;

// DC removal (high-pass) via IIR
float dc = 0.0;
const float DC_ALPHA = 0.995; // close to 1 keeps slow-moving DC

// small moving average for smoothing (low-pass)
const int SMOOTH_N = 5;
float smoothBuf[SMOOTH_N];
int smoothIdx = 0;
float smoothSum = 0.0;

// beat detection
unsigned long lastBeatMicros = 0;
float lastBPM = 0.0;

// adaptive peak/trough tracking for threshold
float peak = -1000.0;
float trough = 1000.0;

// helper to send JSON lines
void sendSample(float value) {
  // send a simple JSON line per sample: {"type":"sample","v":123}
  Serial.print("{\"type\":\"sample\",\"v\":");
  Serial.print((int)round(value));
  Serial.println("}");
}

void sendBPM(int bpm) {
  Serial.print("{\"type\":\"bpm\",\"bpm\":");
  Serial.print(bpm);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  // Allow host to open serial
  delay(1000); // Give time for serial to stabilize
  Serial.println("{\"type\":\"info\",\"msg\":\"ECGReader v1 started\"}");
  Serial.flush();
  // init smooth buffer
  for (int i=0;i<SMOOTH_N;i++) smoothBuf[i] = 0.0;
}

void loop() {
  unsigned long now = micros();
  if ((now - lastSampleMicros) >= SAMPLE_INTERVAL_US) {
    lastSampleMicros = now;

    int raw = analogRead(ECG_PIN); // 0..1023
    // convert to millivolts (assume 5V reference)
    float mv = raw * (5000.0 / 1023.0);

    // DC removal (simple IIR)
    dc = DC_ALPHA * dc + (1.0 - DC_ALPHA) * mv;
    float hp = mv - dc; // high-pass result (centered near 0)

    // smoothing (moving average)
    smoothSum -= smoothBuf[smoothIdx];
    smoothBuf[smoothIdx] = hp;
    smoothSum += smoothBuf[smoothIdx];
    smoothIdx = (smoothIdx + 1) % SMOOTH_N;
    float smooth = smoothSum / SMOOTH_N;

    // update peak/trough with slow decay
    if (smooth > peak) peak = smooth;
    if (smooth < trough) trough = smooth;
    // slowly relax peak/trough towards zero so threshold adapts
    peak *= 0.9998;
    trough *= 0.9998;

    float threshold = (peak + trough) * 0.4; // 0.4 factor empirically chosen

    // basic R-peak detection: crossing threshold with refractory period
    const unsigned long MIN_MS_BETWEEN_BEATS = 250; // 240 BPM max -> 250 ms refractory
    if (smooth > threshold && (now - lastBeatMicros) > (MIN_MS_BETWEEN_BEATS * 1000UL)) {
      if (lastBeatMicros != 0) {
        unsigned long ibi_us = now - lastBeatMicros; // inter-beat interval in microseconds
        float ibi_ms = ibi_us / 1000.0;
        lastBPM = 60000.0 / ibi_ms;
        // send bpm as integer
        sendBPM((int)round(lastBPM));
      }
      lastBeatMicros = now;
      // bump peak so threshold doesn't re-trigger immediately
      peak = smooth;
      trough = smooth - 10;
    }

    // send every sample (consumer UI can downsample if needed)
    sendSample(smooth);
  }
}
