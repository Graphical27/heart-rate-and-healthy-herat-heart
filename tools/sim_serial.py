"""
Small serial simulator for testing the web UI without hardware.

It writes JSON lines similar to the Arduino sketch:
  {"type":"sample","v":123}
  {"type":"bpm","bpm":72}

Set port to your COM port (Windows) or a virtual pair.
"""
import time
import math
import json
import serial

PORT = 'COM5'  # change to the port you want to write to
BAUD = 115200

def main():
    print('Opening', PORT)
    with serial.Serial(PORT, BAUD, timeout=1) as s:
        t0 = time.time()
        while True:
            t = time.time() - t0
            # synthetic ECG-like waveform (not physiologically accurate)
            val = 60 * math.sin(2*math.pi*1.2*t) + 20*math.sin(2*math.pi*20*t) + (math.sin(2*math.pi*0.25*t)*30)
            # occasional spikes to simulate R-peaks
            spike = 0
            if int(t*1.2) != int((t-0.01)*1.2):
                spike = 120
            sample = int(val + spike)
            s.write((json.dumps({"type":"sample","v": sample}) + "\n").encode())
            # send bpm every 2 seconds
            if int(t) % 2 == 0:
                s.write((json.dumps({"type":"bpm","bpm": 70 + int(5*math.sin(0.2*t))}) + "\n").encode())
            time.sleep(0.002)  # ~500 Hz

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('Error', e)
