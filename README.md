# How's My Heart — ECG reader + web UI

This workspace contains:

- `arduino/ECGReader/ECGReader.ino` — Arduino sketch that samples analog pin A1 (~500Hz), applies simple filtering, detects R-peaks and computes BPM, and streams JSON lines over Serial (115200 baud).
- `web/how-my-heart` — Vite + React UI that connects with the Web Serial API to read JSON lines and plot the ECG waveform with:
  - **Needle-style gauge** — shows BPM with an animated pointer/arrow and tick marks
  - **Real 3D animated heart** — CSS 3D transforms create a rotating, beating heart synced to live BPM
  - **Heart Health Index** — combines heart rate and rhythm irregularity into a scored category (Normal / Moderate / High) with a breakdown of contributing factors (bradycardia, tachycardia, irregularity)
  - **Dark theme** — sleek black/dark gradient background
- `tools/sim_serial.py` — small Python script to simulate serial output for UI testing (optional).

Quick start (Windows PowerShell):

1) Upload the Arduino sketch to your Arduino (select correct board & COM port in Arduino IDE). The sketch uses analog pin A1 for ECG input.

2) Start the web app:

```powershell
cd "c:\projects\heart rate and healthy herat heart\web\how-my-heart"
npm install
npm run dev
```

Open the dev URL shown by Vite (usually http://localhost:5173). Click "Connect to device (Web Serial)" and choose your Arduino COM port. The UI will display:
- Live ECG waveform
- Animated 3D heart beating in real-time
- Needle gauge showing current BPM
- Heart Health Index with score breakdown

Simulator (if you don't have hardware):

1) Install pyserial: `pip install pyserial`
2) Edit `tools/sim_serial.py` to set the COM port (or use a virtual COM pair).
3) Run it to stream fake ECG JSON lines and test the web UI.

Notes & caveats:
- The included Arduino detection is a simple, small-footprint algorithm intended for demonstration and prototyping. For clinical-grade detection use a validated algorithm (e.g., Pan-Tompkins) and careful analog front-end.
- If your browser doesn't support Web Serial, use Chrome/Edge with the proper flags or use a small serial-to-web proxy.
- The Heart Health Index is a heuristic screening tool, not diagnostic. Consult a medical professional for clinical advice.
