import random
from datetime import datetime, timedelta

random.seed(270825659)

log_levels = ["INFO", "INFO", "INFO", "INFO", "INFO", "WARN", "DEBUG", "DEBUG"]
auditors = ["auditor_01", "auditor_03", "auditor_05", "auditor_07", "auditor_09", "auditor_12"]
modules = ["auth", "batch_loader", "svg_renderer", "question_parser", "audit_engine", "db_connector", "cache", "export"]

info_messages = [
    "System startup complete",
    "Database connection pool initialized (max=20)",
    "SVG renderer initialized with default settings",
    "Cache cleared successfully",
    "Batch {batch} loaded with {n} questions",
    "User {user} logged in from 192.168.1.{ip}",
    "User {user} logged out",
    "Question {qid} audited successfully",
    "Question {qid} marked as pass",
    "Audit session started for batch {batch}",
    "Audit session completed for batch {batch}",
    "Export completed: batch_{batch}_results.json",
    "Configuration reloaded from audit_rules.yaml",
    "Health check passed - all services operational",
    "Backup completed: audit_db_snapshot_{date}.sql",
    "SVG asset {qid}.svg loaded and validated",
    "Answer key v1 loaded: {n} entries",
    "Answer key v2 loaded: {n} entries",
    "Difficulty ratings synced from master database",
    "Session timeout for user {user} after 30 min inactivity",
    "Report generated: batch_{batch}_summary.md",
    "Memory usage: {mem}MB / 4096MB",
    "CPU usage: {cpu}%",
    "Question {qid} SVG rendered in {ms}ms",
    "Batch {batch} validation complete - no schema errors",
]

warn_messages = [
    "Slow query detected: question lookup took {ms}ms",
    "SVG render timeout for question {qid} - retrying",
    "Cache miss rate above threshold: {rate}%",
    "Disk usage at {disk}% - consider cleanup",
    "Connection pool near capacity: {n}/20 active",
    "Rate limit approaching for user {user}",
    "Deprecated API endpoint called: /v1/audit/submit",
    "Large SVG file detected: {qid}.svg ({size}KB)",
]

debug_messages = [
    "Parsing question {qid} stem text",
    "SVG DOM tree built for {qid}.svg: {n} nodes",
    "Option validation for {qid}: 4 options found",
    "Answer key lookup for {qid}: found in v1",
    "Cache hit for question {qid}",
    "TCP keepalive sent to database server",
    "GC cycle completed: freed {mem}MB",
    "Request ID {rid} processed in {ms}ms",
]

start_date = datetime(2024, 11, 1, 6, 0, 0)
end_date = datetime(2024, 12, 10, 23, 59, 59)
total_seconds = int((end_date - start_date).total_seconds())

lines = []
for i in range(200):
    offset = random.randint(0, total_seconds)
    ts = start_date + timedelta(seconds=offset)
    level = random.choice(log_levels)
    module = random.choice(modules)
    
    qid = random.randint(169600, 169700)
    batch = random.choice([40, 41, 42, 43, 44])
    user = random.choice(auditors)
    
    if level == "INFO":
        template = random.choice(info_messages)
    elif level == "WARN":
        template = random.choice(warn_messages)
    else:
        template = random.choice(debug_messages)
    
    msg = template.format(
        batch=batch,
        n=random.randint(8, 15),
        user=user,
        ip=random.randint(10, 250),
        qid=qid,
        date=ts.strftime("%Y%m%d"),
        mem=random.randint(200, 3500),
        cpu=random.randint(5, 85),
        ms=random.randint(10, 2500),
        rate=random.randint(15, 65),
        disk=random.randint(40, 92),
        size=random.randint(50, 800),
        rid=random.randint(100000, 999999),
    )
    
    line = f"{ts.strftime('%Y-%m-%d %H:%M:%S')} [{level:5s}] [{module}] {msg}"
    lines.append((ts, line))

# Sort by timestamp
lines.sort(key=lambda x: x[0])

with open("logs/audit_system.log", "w", encoding="utf-8") as f:
    for _, line in lines:
        f.write(line + "\n")

print(f"Generated {len(lines)} log lines")
