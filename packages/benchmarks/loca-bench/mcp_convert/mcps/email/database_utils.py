"""
Email Database Utilities

Manages local JSON data files for the simplified Email MCP server.
"""

import json
import os
import sys
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone


class EmailDatabase:
    """Email database implementation using local JSON files"""

    def __init__(self, data_dir: str = None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        self.data_dir = data_dir
        self.users_data_dir = os.path.join(self.data_dir, "users_data")
        self.current_user_email = None  # No user logged in by default
        self.authenticated = False

        # Initialize database if needed
        self._ensure_database_initialized()

        # Per-user data (loaded after login)
        self.emails = {}
        self.folders = {}
        self.drafts = {}

        # Load shared data
        self.users = self._load_json_file("users.json")

    def _ensure_database_initialized(self):
        """Ensure database is initialized, create if needed"""
        try:
            from .init_database import check_database_initialized, initialize_database
        except ImportError:
            # Fallback for direct module execution
            from init_database import check_database_initialized, initialize_database

        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if not check_database_initialized(self.data_dir):
            if not quiet:
                print(f"Database not found or incomplete. Initializing new database in: {self.data_dir}", file=sys.stderr)
            initialize_database(self.data_dir, verbose=not quiet)
            if not quiet:
                print("Database initialization complete", file=sys.stderr)

    def _get_user_data_dir(self, email: str) -> str:
        """Get the data directory for a specific user"""
        return os.path.join(self.users_data_dir, email)

    def _load_user_data(self, email: str):
        """Load data files for a specific user"""
        user_dir = self._get_user_data_dir(email)
        self.emails = self._load_json_file(os.path.join(user_dir, "emails.json"))
        self.folders = self._load_json_file(os.path.join(user_dir, "folders.json"))
        self.drafts = self._load_json_file(os.path.join(user_dir, "drafts.json"))

    def _save_user_data(self):
        """Save current user's data files"""
        if not self.current_user_email:
            return

        user_dir = self._get_user_data_dir(self.current_user_email)
        self._save_json_file(os.path.join(user_dir, "emails.json"), self.emails)
        self._save_json_file(os.path.join(user_dir, "folders.json"), self.folders)
        self._save_json_file(os.path.join(user_dir, "drafts.json"), self.drafts)

    def _load_json_file(self, filename: str) -> dict:
        """Load a JSON file from the data directory or absolute path"""
        # If filename is absolute path, use it directly
        if os.path.isabs(filename):
            filepath = filename
        else:
            filepath = os.path.join(self.data_dir, filename)

        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_json_file(self, filename: str, data: dict):
        """Save data to a JSON file"""
        # If filename is absolute path, use it directly
        if os.path.isabs(filename):
            filepath = filename
        else:
            filepath = os.path.join(self.data_dir, filename)

        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)

    def _generate_id(self, data_dict: dict) -> str:
        """Generate a new ID for a data item"""
        if not data_dict:
            return "1"
        max_id = max([int(k) for k in data_dict.keys()])
        return str(max_id + 1)

    def _update_folder_counts(self):
        """Update folder counts based on current emails"""
        folder_counts = {}
        for email in self.emails.values():
            folder = email.get("folder", "INBOX")
            if folder not in folder_counts:
                folder_counts[folder] = {"total": 0, "unread": 0}
            folder_counts[folder]["total"] += 1
            if not email.get("read", False):
                folder_counts[folder]["unread"] += 1

        # Update folders data
        for folder_name, counts in folder_counts.items():
            if folder_name in self.folders:
                self.folders[folder_name]["total"] = counts["total"]
                self.folders[folder_name]["unread"] = counts["unread"]

        # Reset counts for folders with no emails
        for folder_name in self.folders.keys():
            if folder_name not in folder_counts:
                self.folders[folder_name]["total"] = 0
                self.folders[folder_name]["unread"] = 0

        self._save_user_data()

    # Authentication methods
    def login(self, email: str, password: str) -> dict:
        """Login a user"""
        if email not in self.users:
            raise ValueError(f"User not found: {email}")

        user = self.users[email]
        if user["password"] != password:
            raise ValueError("Invalid password")

        self.current_user_email = email
        self.authenticated = True

        # Load user-specific data
        self._load_user_data(email)

        return {
            "email": user["email"],
            "name": user["name"],
            "logged_in": True,
            "message": f"Successfully logged in as {user['name']}"
        }

    def logout(self) -> dict:
        """Logout the current user"""
        if not self.authenticated:
            raise ValueError("No user is currently logged in")

        previous_user = self.current_user_email
        self.current_user_email = None
        self.authenticated = False

        return {
            "logged_in": False,
            "message": f"Successfully logged out from {previous_user}"
        }

    def get_current_user(self) -> Optional[dict]:
        """Get current logged in user info"""
        if not self.authenticated or not self.current_user_email:
            return None

        return {
            "email": self.current_user_email,
            "name": self.users[self.current_user_email]["name"],
            "logged_in": True
        }

    def list_users(self) -> List[dict]:
        """List all available users (for demo purposes)"""
        return [
            {
                "email": user["email"],
                "name": user["name"]
            }
            for user in self.users.values()
        ]

    def create_user(self, email: str, name: str, password: str) -> dict:
        """
        Create a new user account with mailbox

        Args:
            email: User's email address (must be unique)
            name: User's display name
            password: User's password

        Returns:
            dict: Created user information

        Raises:
            ValueError: If email already exists or is invalid
        """
        # Validate email format
        if not email or "@" not in email:
            raise ValueError("Invalid email address format")

        # Check if user already exists
        if email in self.users:
            raise ValueError(f"User with email {email} already exists")

        # Create user record
        now = datetime.now(timezone.utc).isoformat()
        user_data = {
            "email": email,
            "name": name,
            "password": password,
            "created_at": now
        }

        self.users[email] = user_data

        # Save users.json
        self._save_json_file("users.json", self.users)

        # Initialize user's mailbox
        try:
            from .init_database import initialize_user_mailbox
        except ImportError:
            from init_database import initialize_user_mailbox
        user_data_dir = self._get_user_data_dir(email)
        initialize_user_mailbox(user_data_dir, email, verbose=False)

        return {
            "email": email,
            "name": name,
            "created_at": now,
            "message": f"User {name} ({email}) created successfully"
        }

    def _require_auth(self):
        """Check if user is authenticated"""
        if not self.authenticated or not self.current_user_email:
            raise ValueError("Authentication required. Please login first.")

    def _is_user_email(self, email: dict) -> bool:
        """Check if an email belongs to the current user"""
        return (
            self.current_user_email in email.get("to", "") or
            self.current_user_email in email.get("from", "") or
            self.current_user_email in email.get("cc", "") or
            self.current_user_email in email.get("bcc", "")
        )

    # Connection check
    def check_connection(self) -> dict:
        """Check connection status"""
        return {
            "imap_connected": True,
            "smtp_connected": True,
            "status": "All connections working"
        }

    # Folder methods
    def get_folders(self) -> List[dict]:
        """Get list of all folders"""
        return [{"name": name, **data} for name, data in self.folders.items()]

    def create_folder(self, folder_name: str) -> dict:
        """Create a new folder"""
        if folder_name in self.folders:
            raise ValueError(f"Folder '{folder_name}' already exists")

        self.folders[folder_name] = {
            "name": folder_name,
            "total": 0,
            "unread": 0
        }
        self._save_user_data()
        return self.folders[folder_name]

    def delete_folder(self, folder_name: str) -> bool:
        """Delete a folder"""
        if folder_name in ["INBOX", "Sent", "Drafts", "Trash", "Junk"]:
            raise ValueError(f"Cannot delete system folder: {folder_name}")

        if folder_name not in self.folders:
            raise ValueError(f"Folder '{folder_name}' not found")

        # Move emails from this folder to Trash
        for email in self.emails.values():
            if email.get("folder") == folder_name:
                email["folder"] = "Trash"

        self._save_user_data()
        del self.folders[folder_name]
        self._save_user_data()
        self._update_folder_counts()
        return True

    # Email methods
    def get_emails(self, folder: str = "INBOX", page: int = 1, page_size: int = 20) -> dict:
        """Get paginated list of emails from a folder"""
        self._require_auth()

        # Get emails from folder (all emails belong to current user)
        folder_emails = [
            email for email in self.emails.values()
            if email.get("folder") == folder
        ]

        # Sort by date descending
        folder_emails.sort(key=lambda x: x.get("date", ""), reverse=True)

        # Paginate
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_emails = folder_emails[start_idx:end_idx]

        return {
            "emails": paginated_emails,
            "total": len(folder_emails),
            "page": page,
            "page_size": page_size,
            "total_pages": (len(folder_emails) + page_size - 1) // page_size
        }

    def read_email(self, email_id: str) -> Optional[dict]:
        """Read a specific email"""
        self._require_auth()
        return self.emails.get(email_id)

    def search_emails(self, query: str, folder: str = "INBOX", page: int = 1, page_size: int = 20) -> dict:
        """Search emails by query"""
        self._require_auth()
        query_lower = query.lower()
        matching_emails = []

        for email in self.emails.values():
            if email.get("folder") != folder:
                continue

            # Search in subject, from, to, body
            if (query_lower in email.get("subject", "").lower() or
                query_lower in email.get("from", "").lower() or
                query_lower in email.get("to", "").lower() or
                query_lower in email.get("body", "").lower()):
                matching_emails.append(email)

        # Sort by date descending
        matching_emails.sort(key=lambda x: x.get("date", ""), reverse=True)

        # Paginate
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_emails = matching_emails[start_idx:end_idx]

        return {
            "emails": paginated_emails,
            "total": len(matching_emails),
            "page": page,
            "page_size": page_size,
            "total_pages": (len(matching_emails) + page_size - 1) // page_size
        }

    def send_email(self, to: str, subject: str, body: str, html_body: str = None,
                   cc: str = None, bcc: str = None, attachments: List[str] = None) -> dict:
        """Send a new email"""
        self._require_auth()
        email_id = self._generate_id(self.emails)

        email = {
            "id": email_id,
            "folder": "Sent",
            "from": self.current_user_email,
            "to": to,
            "cc": cc or "",
            "bcc": bcc or "",
            "subject": subject,
            "body": body,
            "html_body": html_body or body,
            "date": datetime.now(timezone.utc).isoformat(),
            "read": True,
            "important": False,
            "has_attachments": bool(attachments),
            "attachments": self._process_attachments(attachments) if attachments else []
        }

        self.emails[email_id] = email
        self._save_user_data()
        self._update_folder_counts()

        # Deliver to recipient if they're a local user
        self._deliver_to_recipients(email, to, cc, bcc)

        return email

    def _deliver_to_recipients(self, email: dict, to: str, cc: str = None, bcc: str = None):
        """Deliver email copy to recipient mailboxes"""
        recipients = []
        if to:
            recipients.extend([r.strip() for r in to.split(",")])
        if cc:
            recipients.extend([r.strip() for r in cc.split(",")])
        if bcc:
            recipients.extend([r.strip() for r in bcc.split(",")])

        # For each recipient that's a local user, add email to their INBOX
        for recipient_email in recipients:
            if recipient_email in self.users and recipient_email != self.current_user_email:
                # Load recipient's data
                recipient_dir = self._get_user_data_dir(recipient_email)
                recipient_emails = self._load_json_file(os.path.join(recipient_dir, "emails.json"))
                recipient_folders = self._load_json_file(os.path.join(recipient_dir, "folders.json"))

                # Create new email ID for recipient
                recipient_email_id = self._generate_id(recipient_emails)

                # Add email to recipient's INBOX
                recipient_email_data = email.copy()
                recipient_email_data["id"] = recipient_email_id
                recipient_email_data["folder"] = "INBOX"
                recipient_email_data["read"] = False

                recipient_emails[recipient_email_id] = recipient_email_data

                # Update recipient's folder counts
                if "INBOX" in recipient_folders:
                    recipient_folders["INBOX"]["total"] = recipient_folders["INBOX"].get("total", 0) + 1
                    recipient_folders["INBOX"]["unread"] = recipient_folders["INBOX"].get("unread", 0) + 1

                # Save recipient's data
                self._save_json_file(os.path.join(recipient_dir, "emails.json"), recipient_emails)
                self._save_json_file(os.path.join(recipient_dir, "folders.json"), recipient_folders)

    def reply_email(self, email_id: str, body: str, html_body: str = None,
                    cc: str = None, bcc: str = None, reply_all: bool = False) -> dict:
        """Reply to an email"""
        original = self.emails.get(email_id)
        if not original:
            raise ValueError(f"Email not found: {email_id}")

        # Determine recipients
        to = original["from"]
        reply_cc = ""

        if reply_all:
            # Include original CC recipients
            if original.get("cc"):
                reply_cc = original["cc"]
            if cc:
                reply_cc = f"{reply_cc},{cc}" if reply_cc else cc
        elif cc:
            reply_cc = cc

        subject = original["subject"]
        if not subject.startswith("Re: "):
            subject = f"Re: {subject}"

        return self.send_email(
            to=to,
            subject=subject,
            body=body,
            html_body=html_body,
            cc=reply_cc or None,
            bcc=bcc
        )

    def forward_email(self, email_id: str, to: str, body: str = None,
                     html_body: str = None, cc: str = None, bcc: str = None) -> dict:
        """Forward an email"""
        original = self.emails.get(email_id)
        if not original:
            raise ValueError(f"Email not found: {email_id}")

        subject = original["subject"]
        if not subject.startswith("Fwd: "):
            subject = f"Fwd: {subject}"

        # Combine new message with original
        forward_body = f"{body}\n\n--- Forwarded message ---\n{original['body']}" if body else f"--- Forwarded message ---\n{original['body']}"

        return self.send_email(
            to=to,
            subject=subject,
            body=forward_body,
            html_body=html_body,
            cc=cc,
            bcc=bcc,
            attachments=[att["filename"] for att in original.get("attachments", [])]
        )

    def delete_email(self, email_id: str) -> bool:
        """Delete an email"""
        if email_id not in self.emails:
            raise ValueError(f"Email not found: {email_id}")

        email = self.emails[email_id]
        if email["folder"] == "Trash":
            # Permanently delete
            del self.emails[email_id]
        else:
            # Move to Trash
            email["folder"] = "Trash"

        self._save_user_data()
        self._update_folder_counts()
        return True

    def move_email(self, email_id: str, target_folder: str) -> dict:
        """Move email to another folder"""
        if email_id not in self.emails:
            raise ValueError(f"Email not found: {email_id}")

        if target_folder not in self.folders:
            raise ValueError(f"Folder not found: {target_folder}")

        self.emails[email_id]["folder"] = target_folder
        self._save_user_data()
        self._update_folder_counts()

        return self.emails[email_id]

    def mark_emails(self, email_ids: List[str], status: str) -> List[dict]:
        """Mark multiple emails with status"""
        updated_emails = []

        for email_id in email_ids:
            if email_id in self.emails:
                email = self.emails[email_id]

                if status == "read":
                    email["read"] = True
                elif status == "unread":
                    email["read"] = False
                elif status == "important":
                    email["important"] = True
                elif status == "not_important":
                    email["important"] = False

                updated_emails.append(email)

        self._save_user_data()
        self._update_folder_counts()

        return updated_emails

    def move_emails(self, email_ids: List[str], target_folder: str) -> List[dict]:
        """Move multiple emails to another folder"""
        if target_folder not in self.folders:
            raise ValueError(f"Folder not found: {target_folder}")

        moved_emails = []
        for email_id in email_ids:
            if email_id in self.emails:
                self.emails[email_id]["folder"] = target_folder
                moved_emails.append(self.emails[email_id])

        self._save_user_data()
        self._update_folder_counts()

        return moved_emails

    def delete_emails(self, email_ids: List[str]) -> bool:
        """Delete multiple emails"""
        for email_id in email_ids:
            if email_id in self.emails:
                email = self.emails[email_id]
                if email["folder"] == "Trash":
                    del self.emails[email_id]
                else:
                    email["folder"] = "Trash"

        self._save_user_data()
        self._update_folder_counts()
        return True

    # Draft methods
    def save_draft(self, subject: str, body: str, html_body: str = None,
                   to: str = None, cc: str = None, bcc: str = None) -> dict:
        """Save email draft"""
        draft_id = self._generate_id(self.drafts)

        draft = {
            "id": draft_id,
            "to": to or "",
            "cc": cc or "",
            "bcc": bcc or "",
            "subject": subject,
            "body": body,
            "html_body": html_body or body,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }

        self.drafts[draft_id] = draft
        self._save_user_data()

        return draft

    def get_drafts(self, page: int = 1, page_size: int = 20) -> dict:
        """Get paginated list of drafts"""
        drafts_list = list(self.drafts.values())
        drafts_list.sort(key=lambda x: x.get("updated_at", ""), reverse=True)

        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_drafts = drafts_list[start_idx:end_idx]

        return {
            "drafts": paginated_drafts,
            "total": len(drafts_list),
            "page": page,
            "page_size": page_size,
            "total_pages": (len(drafts_list) + page_size - 1) // page_size
        }

    def update_draft(self, draft_id: str, updates: dict) -> dict:
        """Update existing draft"""
        if draft_id not in self.drafts:
            raise ValueError(f"Draft not found: {draft_id}")

        self.drafts[draft_id].update(updates)
        self.drafts[draft_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_user_data()

        return self.drafts[draft_id]

    def delete_draft(self, draft_id: str) -> bool:
        """Delete draft"""
        if draft_id not in self.drafts:
            raise ValueError(f"Draft not found: {draft_id}")

        del self.drafts[draft_id]
        self._save_user_data()
        return True

    # Statistics methods
    def get_mailbox_stats(self, folder_name: str = None) -> dict:
        """Get mailbox statistics"""
        if folder_name:
            if folder_name not in self.folders:
                raise ValueError(f"Folder not found: {folder_name}")
            return self.folders[folder_name]

        total_emails = len(self.emails)
        total_unread = sum(1 for email in self.emails.values() if not email.get("read", False))

        return {
            "total_emails": total_emails,
            "total_unread": total_unread,
            "folders": self.folders
        }

    def get_unread_count(self, folder_name: str = None) -> int:
        """Get unread message count"""
        if folder_name:
            if folder_name not in self.folders:
                raise ValueError(f"Folder not found: {folder_name}")
            return self.folders[folder_name]["unread"]

        return sum(1 for email in self.emails.values() if not email.get("read", False))

    def get_email_headers(self, email_id: str) -> dict:
        """Get email headers"""
        email = self.emails.get(email_id)
        if not email:
            raise ValueError(f"Email not found: {email_id}")

        return {
            "message_id": email_id,
            "from": email["from"],
            "to": email["to"],
            "cc": email.get("cc", ""),
            "subject": email["subject"],
            "date": email["date"],
            "content_type": "text/html" if email.get("html_body") else "text/plain"
        }

    # Export/Import methods
    def export_emails(self, folder: str = None, export_all_folders: bool = False,
                     max_emails: int = None) -> List[dict]:
        """Export emails for backup"""
        if export_all_folders:
            emails_to_export = list(self.emails.values())
        elif folder:
            emails_to_export = [
                email for email in self.emails.values()
                if email.get("folder") == folder
            ]
        else:
            emails_to_export = list(self.emails.values())

        if max_emails:
            emails_to_export = emails_to_export[:max_emails]

        return emails_to_export

    def import_emails(self, emails_data: List[dict], target_folder: str = None,
                     preserve_folders: bool = True) -> int:
        """Import emails from backup"""
        imported_count = 0

        for email_data in emails_data:
            email_id = self._generate_id(self.emails)

            # Set folder
            if not preserve_folders and target_folder:
                email_data["folder"] = target_folder
            elif "folder" not in email_data:
                email_data["folder"] = "INBOX"

            # Ensure required fields
            email_data["id"] = email_id
            if "date" not in email_data:
                email_data["date"] = datetime.now(timezone.utc).isoformat()
            if "read" not in email_data:
                email_data["read"] = False

            self.emails[email_id] = email_data
            imported_count += 1

        self._save_user_data()
        self._update_folder_counts()

        return imported_count

    def download_attachment(self, email_id: str, attachment_filename: str) -> dict:
        """Get attachment information for download"""
        email = self.emails.get(email_id)
        if not email:
            raise ValueError(f"Email not found: {email_id}")

        for attachment in email.get("attachments", []):
            if attachment["filename"] == attachment_filename:
                return {
                    "filename": attachment["filename"],
                    "size": attachment["size"],
                    "content_type": attachment.get("content_type", "application/octet-stream"),
                    "message": f"Attachment '{attachment_filename}' ready for download (simulated)"
                }

        raise ValueError(f"Attachment not found: {attachment_filename}")

    def _process_attachments(self, attachment_paths: List[str]) -> List[dict]:
        """Process attachment paths into attachment metadata

        Args:
            attachment_paths: List of file paths to process

        Returns:
            List of attachment dictionaries with metadata including:
            - filename: The base filename
            - path: Full path to the file
            - size: Actual file size in bytes
            - content_type: MIME type of the file
            - content: Base64 encoded file content (optional, for small files)

        Raises:
            ValueError: If any attachment file does not exist or is outside agent_workspace
        """
        import base64

        # Derive agent_workspace from users_data_dir if not explicitly set
        # Directory structure: .../run_0/local_db/emails/users_data
        # Agent workspace is at: .../run_0/agent_workspace
        agent_workspace = None
        if self.users_data_dir:
            # Go up from users_data_dir: users_data -> emails -> local_db -> run_0
            run_dir = os.path.dirname(os.path.dirname(os.path.dirname(self.users_data_dir)))
            agent_workspace = os.path.join(run_dir, "agent_workspace")
            if os.path.exists(agent_workspace):
                agent_workspace = os.path.abspath(agent_workspace)

        attachments = []
        for path in attachment_paths:
            # Validate file exists
            if not os.path.exists(path):
                raise ValueError(f"Attachment file not found: {path}")

            # Strict validation: attachment must be within agent_workspace
            abs_path = os.path.abspath(path)
            if agent_workspace:
                # Ensure the path is within agent_workspace
                if not abs_path.startswith(agent_workspace + os.sep) and abs_path != agent_workspace:
                    raise ValueError(
                        f"Attachment must be within agent_workspace. "
                        f"File '{path}' is outside the allowed workspace directory."
                    )

            # Extract filename from path
            filename = os.path.basename(path)
            file_size = os.path.getsize(path)
            content_base64 = None

            # For files smaller than 10MB, include base64 content
            # This allows the attachment to be accessed even if the original file is moved
            if file_size < 10 * 1024 * 1024:  # 10MB limit
                try:
                    with open(path, 'rb') as f:
                        file_content = f.read()
                        content_base64 = base64.b64encode(file_content).decode('utf-8')
                except Exception as e:
                    print(f"Warning: Could not read attachment content from {path}: {e}", file=sys.stderr)

            attachment_data = {
                "filename": filename,
                "path": os.path.abspath(path),  # Store absolute path
                "size": file_size,
                "content_type": self._guess_content_type(filename)
            }

            # Only include content if it was successfully read
            # if content_base64:
            #     attachment_data["content"] = content_base64

            attachments.append(attachment_data)

        return attachments

    def _guess_content_type(self, filename: str) -> str:
        """Guess content type from filename"""
        ext = os.path.splitext(filename)[1].lower()
        content_types = {
            ".pdf": "application/pdf",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".txt": "text/plain",
            ".zip": "application/zip"
        }
        return content_types.get(ext, "application/octet-stream")
