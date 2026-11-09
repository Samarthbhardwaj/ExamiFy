# 📝 Paper Simulator — Mock Exam Generator & Performance Analyzer

A full-stack multi-agent web application that ingests question banks, generates balanced 40-question mock exams (timed for 60 minutes), provides a real-time exam taking UI, and performs deep diagnostic analysis with visual reports.

---

## 🚀 Quick Start

The server is currently running at **http://localhost:3000**.

To run it anytime in the future:
```cmd
# Double click start.bat or run:
d:\ExamTester\start.bat
```
Or with Node.js in your PATH:
```bash
node server.js
```

---

## 🤖 Multi-Agent Architecture

The system is built as a pipeline of **7 distinct agents** coordinating through strict data contracts:

```
[Uploaded Question Bank]
          │
          ▼
1. IngestionAgent ──(Validates schema, normalizes taxonomy, flags duplicates)
          │
          ▼ [Clean Question Pool + Validation Report]
2. ComposerAgent ──(PRNG-seeded balanced composition: 40% E, 40% M, 20% H, ~60 min)
          │
          ▼ [Mock Paper (40 questions, answers stripped)]
3. SessionAgent ──(Tracks question timings, navigation, revisits, auto-submit)
          │
          ▼ [Structured Session Log]
4. EvaluationAgent ──(Scores against answer key, topic/difficulty breakdowns)
          │
          ▼ [Structured Metrics]
5. WeaknessAgent ──(Detects rush guessing, fatigue, slow wrong answers, ranks weak areas)
          │
          ▼ [Ranked Weaknesses + Insights]
6. ReportAgent ──(Builds score summary, Chart.js payload, recommendations, prior comparison)
          │
          ▼
[Results Dashboard + Persistence in /data/attempts]
```

### Coordinator:
- **Orchestrator** (`agents/orchestrator.js`): Coordinates state transitions (`uploading` → `paper-ready` → `in-progress` → `submitted` → `report-ready`) and handles error isolation.

---

## 📁 Project Structure

```
d:\ExamTester\
├── agents\
│   ├── base-agent.js          # Base class for all agents
│   ├── registry.js            # Central agent registry
│   ├── ingestion-agent.js     # Validates schema & normalizes taxonomy
│   ├── composer-agent.js      # Seeded 40-question exam composition
│   ├── session-agent.js       # Session logging & timing metrics
│   ├── evaluation-agent.js    # Scoring & structured metrics
│   ├── weakness-agent.js      # Behavioral & weakness insights
│   ├── report-agent.js        # Report aggregation & history comparison
│   └── orchestrator.js        # Pipeline orchestrator
├── data\
│   └── attempts\              # Historical attempt records (JSON)
├── public\
│   ├── index.html             # Single Page Application views
│   ├── styles.css             # Dark glassmorphic design system
│   └── app.js                 # SPA engine, timer ring, charts, keyboard shortcuts
├── sample-questions.json      # 80 pre-built CS questions across 5 core topics
├── server.js                  # Express API server
├── start.bat                  # One-click launcher
└── package.json
```

---

## 🎯 Features

1. **Upload & Schema Validation**:
   - Supports drag-and-drop or pasting JSON.
   - Built-in "Load Sample Questions" button (82 CS questions) and "Load Code Snippets Bank" (44 coding questions).
   - Strict field validation with clear warning/error reports.

2. **Custom Paper Configuration**:
   - **Custom Question Count**: Select 10, 20, 30, 40, or any custom count up to the available pool.
   - **Topic Filtering**: Multi-select specific topics (e.g. only "Python" or "SQL + JavaScript") with dynamic count recalculation.
   - **Custom Exam Duration**: Presets for 15, 30, 45, 60, 90 mins or custom time, with dynamic pacing diagnostics (sec/question).

3. **Exam Interface**:
   - Dynamic countdown with animated SVG progress ring and color warnings based on chosen duration.
   - Question palette with status indicators (answered, flagged, remaining).
   - Flagging questions for review.
   - Keyboard shortcuts (`←`/`→` to navigate, `1`-`4` to select, `F` to flag).
   - Auto-submit when the timer expires.

3. **Performance Analysis Dashboard**:
   - **Radar Chart**: Topic accuracy percentages.
   - **Bar Chart**: Difficulty distribution (Easy / Medium / Hard).
   - **Line Chart**: Time spent vs. recommended time per question.
   - **Ranked Weak Areas**: Ranked by impact on overall score.
   - **Guessing Pattern Detection**: Distinguishes "rushed wrong" (guessing) from "slow wrong" (struggling).
   - **Question Review**: Itemized breakdown with correct answers and detailed explanations.
   - **Historical Tracking**: Progress over time across repeated mock exams.

---

## ☁️ Linux / AWS EC2 Deployment Guide

Follow these steps to deploy Paper Simulator on an Ubuntu or Amazon Linux EC2 instance.

### 1. Launch EC2 Instance & Configure Security Group
- **AMI**: Ubuntu 22.04 LTS or Amazon Linux 2023.
- **Instance Type**: `t3.micro` or `t3.small`.
- **Inbound Security Group Rules**:
  - `SSH` (Port 22) from your IP.
  - `Custom TCP` (Port 3000) from `0.0.0.0/0` (or `HTTP` Port 80 if using Nginx reverse proxy).

### 2. Install Node.js (v20+ LTS)
```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Verify installation
node -v
npm -v
```

### 3. Clone / Copy Repository & Install Dependencies
```bash
# Create app directory
sudo mkdir -p /var/www/paper-simulator
sudo chown -R $USER:$USER /var/www/paper-simulator
cd /var/www/paper-simulator

# Copy project files here or git clone, then install dependencies:
npm install --production
```

### 4. Configure Environment Variables (.env)
Create your `.env` file in `/var/www/paper-simulator/.env`:
```bash
cp .env.example .env
nano .env
```
Ensure the following are set:
```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
GEMINI_API_KEY=your_google_gemini_api_key_here
```
> **Security Note:** The server embeds and protects `GEMINI_API_KEY`. It is never sent to or visible in client browser network payloads or code.

### 5. Option A: Run with PM2 (Recommended)
```bash
# Install PM2 globally
sudo npm install -g pm2

# Start application using ecosystem file
pm2 start ecosystem.config.cjs

# Configure PM2 to auto-start on system reboot
pm2 startup
pm2 save

# Check logs & status
pm2 status
pm2 logs paper-simulator
```

### 5. Option B: Run as a systemd Service
```bash
sudo cp deploy/paper-simulator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable paper-simulator
sudo systemctl start paper-simulator
sudo systemctl status paper-simulator
```

### 6. Accessing the Application
Open your browser to:
```
http://<EC2-PUBLIC-IP>:3000
```

- **Guest Protection**: Visitors must log in or register before they can upload banks, generate AI quizzes, or take exams.
- **Default Admin User**: You can log in or register as `admin` to access global bank publishing and management.

