# IT Security Policy — Excerpt: File Storage and Access Controls

**Document ID:** IT-SEC-POL-2024-008  
**Effective Date:** 2024-06-01  
**Classification:** Internal Use Only  
**Last Reviewed:** 2025-09-15

---

## 1. File Access Permissions

All project files stored on company workstations and network drives must adhere to the
principle of least privilege. Access permissions shall be configured as follows:

- **Project Team Members:** Read/Write access to their assigned project folders only.
- **Project Managers:** Read/Write access plus ability to grant temporary access to reviewers.
- **Department Heads:** Read-only access to all projects within their department.
- **IT Administrators:** Full control for maintenance purposes only; access must be logged.

Access requests must be submitted through the IT Service Portal (Form IT-ACC-003) and
approved by the respective Project Manager and Department Head.

## 2. Approved Storage Locations

| Drive | Purpose | Backup Status |
|-------|---------|---------------|
| C:\ | Operating system and applications only | System image weekly |
| **D:\** | **Approved for project file storage** | Weekly incremental, monthly full |
| E:\ | Personal files and temporary data | Not backed up |
| \\\\file-srv01\shared\ | Cross-department shared resources | Daily incremental |

> **Note:** The D: drive is the designated local storage location for active project files.
> All project data on D: drive is included in the automated backup schedule.

## 3. Backup Schedules

Project files must be backed up according to the following schedule:

- **Weekly Incremental Backup:** Every Friday at 22:00, all modified files on D: drive
  are backed up to \\\\backup-srv01\projects$.
- **Monthly Full Backup:** First Saturday of each month at 20:00, a complete snapshot
  of the D: drive is created.
- **Retention Period:** Weekly backups retained for 90 days; monthly backups retained
  for 3 years.

Project teams are responsible for ensuring that all critical deliverables are saved to
the D: drive before the weekly backup window.

## 4. Encryption Requirements

Sensitive project documents must be encrypted when:

- Transmitted via email outside the corporate network.
- Stored on removable media (USB drives, external hard drives).
- Shared with external parties through cloud platforms.

Approved encryption tools:
- 7-Zip (AES-256) for file archives
- BitLocker for full-drive encryption on portable devices
- Company-approved VPN for remote access to project files

Client-confidential documents (marked "CONFIDENTIAL" or "RESTRICTED") must be stored
in encrypted subfolders. Contact IT Security for setup assistance.

## 5. Network Drive vs. Local Drive Policies

- Active project work should be performed on the **local D: drive** for performance.
- Completed deliverables should be copied to the network share for team access.
- Do not store the only copy of critical files on local drives without backup.
- Network drives (\\\\file-srv01) should be used for cross-team collaboration files.

## 6. Incident Reporting

Any suspected unauthorized access, data loss, or security breach involving project
files must be reported to IT Security within 4 hours via:

- Email: it-security@company.com
- Phone: ext. 8800
- IT Service Portal: Incident Report Form

---

*This excerpt is provided for reference. For the complete IT Security Policy, refer to
document IT-SEC-POL-2024-001 on the corporate intranet.*
