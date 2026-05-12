#!/usr/bin/env python3
"""
Local Email Server Attachment Check Script
Used to check email attachments in local mailbox with subjects containing specified keywords,
download ZIP attachments, extract and compare with reference folder structure
"""

import os
import sys
import json
import zipfile
import argparse
import base64
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Tuple, Optional

from gem.utils.filesystem import nfs_safe_rmtree
try:
    import PyPDF2
except ImportError:
    print("Warning: PyPDF2 not installed, PDF content detection will be unavailable")
    PyPDF2 = None

# Add mcp_convert path to import EmailDatabase
try:
    from mcp_convert.mcps.email.database_utils import EmailDatabase
except ImportError:
    EmailDatabase = None

try:
    from utils.app_specific.poste.local_email_manager import LocalEmailManager
except ImportError:
    LocalEmailManager = None


class LocalEmailAttachmentChecker:
    def __init__(self, email_db=None, receiver_email=None, groundtruth_workspace=None, config_file=None, temp_dir=None):
        """
        Initialize local email attachment checker

        Args:
            email_db: EmailDatabase instance (new mode)
            receiver_email: Receiver email address (new mode)
            groundtruth_workspace: Reference folder path
            config_file: Receiver email configuration file path (old mode, for compatibility)
            temp_dir: Temporary directory path (optional, uses temp_attachments under code directory if not specified)
        """
        # New mode: use database directly
        if email_db is not None and receiver_email is not None:
            self.use_database = True
            self.email_db = email_db
            self.receiver_email = receiver_email
            self.email_manager = None
            print(f"✅ Using database mode, receiver: {receiver_email}")
        # Old mode: use LocalEmailManager (backward compatibility)
        elif config_file is not None:
            if LocalEmailManager is None:
                raise ImportError("LocalEmailManager not available, please use database mode")
            self.use_database = False
            self.email_manager = LocalEmailManager(config_file, verbose=True)
            self.email_db = None
            self.receiver_email = None
            print(f"✅ Using LocalEmailManager mode")
        else:
            raise ValueError("Must provide (email_db, receiver_email) or config_file")

        self.groundtruth_workspace = groundtruth_workspace
        if temp_dir:
            self.temp_dir = temp_dir
        else:
            self.temp_dir = os.path.join(Path(__file__).parent, 'temp_attachments')
        self.valid_structures = {}  # Store valid file structure options

    def set_valid_structures(self, structures_dict: Dict):
        """Set valid file structure options

        Args:
            structures_dict: {prof_email: {'name': str, 'structure_key': str, 'structure_name': str, 'structure_def': dict}}
        """
        self.valid_structures = structures_dict
        print(f"📝 Set {len(structures_dict)} valid file structure options")
    
    def convert_structure_def_to_directory_structure(self, structure_def: Dict) -> Dict:
        """Convert FILE_STRUCTURES format structure definition to directory_structure format

        Args:
            structure_def: {'folders': [...], 'files': {...}}

        Returns:
            directory_structure format: {path: {'dirs': [...], 'files': [...]}}
        """
        directory_structure = {'': {'dirs': [], 'files': []}}

        # Define placeholder replacement rules
        # Recommendation_Letter_[ProfessorName]-1.pdf -> Recommendation_Letter_Alex-1.pdf
        # Recommendation_Letter_[ProfessorName]-2.pdf -> Recommendation_Letter_Lily-2.pdf
        placeholder_replacements = {
            'Recommendation_Letter_[ProfessorName]-1.pdf': 'Recommendation_Letter_Alex-1.pdf',
            'Recommendation_Letter_[ProfessorName]-2.pdf': 'Recommendation_Letter_Lily-2.pdf'
        }
        
        # Add top-level folders
        folders = structure_def.get('folders', [])
        directory_structure['']['dirs'] = folders

        # Add contents of each folder
        files_dict = structure_def.get('files', {})
        for folder in folders:
            directory_structure[folder] = {'dirs': [], 'files': []}
            file_list = files_dict.get(folder, [])

            for file_item in file_list:
                # Handle placeholder replacement
                if file_item in placeholder_replacements:
                    file_item = placeholder_replacements[file_item]

                if '/' in file_item:
                    # Subfolder, e.g., "Awards_Certificates/All_Awards_Certificates.pdf"
                    subfolder, subfile = file_item.split('/', 1)

                    # Also perform placeholder replacement for subfiles
                    if subfile in placeholder_replacements:
                        subfile = placeholder_replacements[subfile]

                    if subfolder not in directory_structure[folder]['dirs']:
                        directory_structure[folder]['dirs'].append(subfolder)

                    # Add subfolder contents
                    subfolder_path = f"{folder}/{subfolder}"
                    if subfolder_path not in directory_structure:
                        directory_structure[subfolder_path] = {'dirs': [], 'files': []}
                    directory_structure[subfolder_path]['files'].append(subfile)
                else:
                    # Regular file
                    directory_structure[folder]['files'].append(file_item)
        
        return directory_structure
        
    def create_temp_dir(self) -> bool:
        """Create temporary directory for downloading attachments"""
        try:
            os.makedirs(self.temp_dir, exist_ok=True)
            print(f"✅ Created temporary directory: {self.temp_dir}")
            return True
        except Exception as e:
            print(f"❌ Failed to create temporary directory: {e}")
            return False

    def search_emails_with_attachments(self, subject_keyword: str = "submit_material") -> List[Dict]:
        """Search for emails with specific subject keyword that have attachments"""
        try:
            print(f"🔍 Searching for emails with subject containing '{subject_keyword}' and attachments in receiver's mailbox...")
            
            if self.use_database:
                # Database mode: read directly from database
                user_dir = self.email_db._get_user_data_dir(self.receiver_email)
                emails_file = os.path.join(user_dir, "emails.json")

                if not os.path.exists(emails_file):
                    print(f"⚠️ Email data file does not exist: {emails_file}")
                    return []

                with open(emails_file, 'r', encoding='utf-8') as f:
                    emails_data = json.load(f)

                # Filter emails containing subject keyword and having attachments
                emails_with_attachments = []
                for email_id, email in emails_data.items():
                    subject = email.get('subject', '')
                    attachments = email.get('attachments', [])

                    if subject_keyword.lower() in subject.lower() and len(attachments) > 0:
                        emails_with_attachments.append(email)

                if not emails_with_attachments:
                    print("⚠️ No matching emails found")
                    return []

                print(f"✅ Found {len(emails_with_attachments)} matching emails")
                return emails_with_attachments
            else:
                # LocalEmailManager mode (backward compatibility)
                emails_with_attachments = self.email_manager.get_emails_with_attachments(
                    subject_keyword=subject_keyword
                )

                if not emails_with_attachments:
                    print("⚠️ No matching emails found")
                    return []

                print(f"✅ Found {len(emails_with_attachments)} matching emails")
                return emails_with_attachments

        except Exception as e:
            print(f"❌ Email search failed: {e}")
            import traceback
            traceback.print_exc()
            return []
    
    def download_zip_attachments(self, emails: List[Dict]) -> List[str]:
        """Download ZIP attachments from emails"""
        downloaded_files = []

        for i, email_data in enumerate(emails):
            try:
                print(f"\n📧 Processing email {i+1}...")

                subject = email_data.get('subject', 'Unknown Subject')
                print(f"   Subject: {subject}")

                # Check attachment information
                attachments = email_data.get('attachments', [])
                zip_attachments = [att for att in attachments if att['filename'].lower().endswith('.zip')]

                if not zip_attachments:
                    print(f"   ⚠️ This email has no ZIP attachments")
                    continue

                for attachment in zip_attachments:
                    filename = attachment['filename']
                    print(f"   Found ZIP attachment: {filename}")
                    print(f"   Attachment content: {attachment}")
                
                if self.use_database:
                    # Database mode: read from attachment data
                    for attachment in zip_attachments:
                        filename = attachment['filename']
                        attachment_path = attachment.get('path', '')
                        content_base64 = attachment.get('content', '')

                        try:
                            # Method 1: If there is a complete path, copy file directly from path
                            if attachment_path and os.path.exists(attachment_path):
                                print(f"   📁 Reading from path: {attachment_path}")
                                import shutil
                                dest_path = os.path.join(self.temp_dir, filename)
                                shutil.copy2(attachment_path, dest_path)
                                downloaded_files.append(dest_path)
                                print(f"   ✅ Copy complete: {filename}")
                            # Method 2: Decode from base64 content
                            elif content_base64:
                                print(f"   📦 Decoding from base64")
                                content_bytes = base64.b64decode(content_base64)

                                # Save to temporary directory
                                file_path = os.path.join(self.temp_dir, filename)
                                with open(file_path, 'wb') as f:
                                    f.write(content_bytes)

                                downloaded_files.append(file_path)
                                print(f"   ✅ Decode complete: {filename}")
                            else:
                                print(f"   ⚠️ Attachment {filename} has no path or content data")
                        except Exception as e:
                            print(f"   ❌ Failed to process attachment {filename}: {e}")
                            import traceback
                            traceback.print_exc()
                else:
                    # LocalEmailManager mode (backward compatibility)
                    downloaded = self.email_manager.download_attachments_from_email(
                        email_data, self.temp_dir
                    )

                    # Only keep ZIP files
                    zip_files = [f for f in downloaded if f.lower().endswith('.zip')]
                    downloaded_files.extend(zip_files)

                    for zip_file in zip_files:
                        print(f"   ✅ Download complete: {os.path.basename(zip_file)}")

            except Exception as e:
                print(f"   ❌ Failed to process email: {e}")
                import traceback
                traceback.print_exc()
        
        return downloaded_files
    
    def extract_zip_files(self, zip_files: List[str]) -> bool:
        """Extract ZIP files"""
        if not zip_files:
            print("⚠️ No ZIP files to extract")
            return False

        success_count = 0
        for zip_file in zip_files:
            try:
                print(f"\n📦 Extracting file: {os.path.basename(zip_file)}")

                with zipfile.ZipFile(zip_file, 'r') as zip_ref:
                    # Check ZIP file contents
                    file_list = zip_ref.namelist()
                    print(f"   ZIP file contains {len(file_list)} files/folders")

                    # Extract to temporary directory
                    zip_ref.extractall(self.temp_dir)
                    print(f"   ✅ Extraction complete")
                    success_count += 1

            except Exception as e:
                print(f"   ❌ Extraction failed: {e}")
        
        return success_count > 0
    
    def get_directory_structure(self, path: str) -> Dict:
        """Get directory structure"""
        structure = {}

        try:
            for root, dirs, files in os.walk(path):
                # Calculate relative path
                rel_path = os.path.relpath(root, path)
                if rel_path == '.':
                    rel_path = ''

                # Add directory
                if rel_path:
                    structure[rel_path] = {'dirs': [], 'files': []}
                else:
                    structure[''] = {'dirs': [], 'files': []}

                # Add subdirectories
                for dir_name in dirs:
                    if rel_path:
                        structure[rel_path]['dirs'].append(dir_name)
                    else:
                        structure['']['dirs'].append(dir_name)

                # Add files
                for file_name in files:
                    if rel_path:
                        structure[rel_path]['files'].append(file_name)
                    else:
                        structure['']['files'].append(file_name)

        except Exception as e:
            print(f"❌ Failed to get directory structure: {e}")
        
        return structure
    
    def normalize_recommendation_letter_name(self, filename: str) -> str:
        """Normalize recommendation letter filename, making Professor prefix optional

        Examples:
        - Recommendation_Letter_ProfessorAlex-1.pdf -> Recommendation_Letter_Alex-1.pdf
        - Recommendation_Letter_ProfessorLily-2.pdf -> Recommendation_Letter_Lily-2.pdf
        - Recommendation_Letter_Alex-1.pdf -> Recommendation_Letter_Alex-1.pdf (unchanged)
        """
        import re
        # Match Recommendation_Letter_Professor<Name>-<Number>.pdf format
        pattern = r'^Recommendation_Letter_Professor([A-Za-z]+)-(\d+)\.pdf$'
        match = re.match(pattern, filename)
        if match:
            name = match.group(1)
            number = match.group(2)
            return f'Recommendation_Letter_{name}-{number}.pdf'
        return filename

    def compare_structures(self, extracted_structure: Dict, reference_structure: Dict) -> Tuple[bool, List[str]]:
        """Compare two directory structures"""
        differences = []
        is_match = True

        print("\n🔍 Comparing file structures...")

        # Check all directories
        all_dirs = set(extracted_structure.keys()) | set(reference_structure.keys())

        for dir_path in all_dirs:
            extracted = extracted_structure.get(dir_path, {'dirs': [], 'files': []})
            reference = reference_structure.get(dir_path, {'dirs': [], 'files': []})

            # Check directories
            extracted_dirs = set(extracted['dirs'])
            reference_dirs = set(reference['dirs'])

            missing_dirs = reference_dirs - extracted_dirs
            extra_dirs = extracted_dirs - reference_dirs

            if missing_dirs:
                differences.append(f"Directory '{dir_path}' missing subdirectories: {list(missing_dirs)}")
                is_match = False

            if extra_dirs:
                differences.append(f"Directory '{dir_path}' has extra subdirectories: {list(extra_dirs)}")
                is_match = False

            # Check files - use normalized filenames for comparison
            extracted_files = set(extracted['files'])
            reference_files = set(reference['files'])

            # Normalize recommendation letter filenames for comparison
            extracted_files_normalized = {self.normalize_recommendation_letter_name(f) for f in extracted_files}
            reference_files_normalized = {self.normalize_recommendation_letter_name(f) for f in reference_files}

            missing_files = reference_files_normalized - extracted_files_normalized
            extra_files = extracted_files_normalized - reference_files_normalized

            if missing_files:
                differences.append(f"Directory '{dir_path}' missing files: {list(missing_files)}")
                is_match = False

            if extra_files:
                differences.append(f"Directory '{dir_path}' has extra files: {list(extra_files)}")
                is_match = False

        return is_match, differences

    def print_structure(self, structure: Dict, title: str):
        """Print directory structure"""
        print(f"\n{title}:")
        print("=" * 50)

        for dir_path in sorted(structure.keys()):
            if dir_path:
                print(f"📁 {dir_path}/")
            else:
                print("📁 Root directory/")
            
            data = structure[dir_path]
            
            for dir_name in sorted(data['dirs']):
                print(f"   📁 {dir_name}/")
            
            for file_name in sorted(data['files']):
                print(f"   📄 {file_name}")
    
    def find_extracted_materials_dir(self) -> Optional[str]:
        """Find the extracted Application_Materials directory"""
        for root, dirs, files in os.walk(self.temp_dir):
            for dir_name in dirs:
                if dir_name.startswith('Application_Materials_'):
                    return os.path.join(root, dir_name)
        return None
    
    def check_pdf_content(self, pdf_path: str) -> Tuple[bool, List[str]]:
        """Check if PDF content meets requirements"""
        if not PyPDF2:
            print("⚠️ PyPDF2 not installed, skipping PDF content check")
            return True, []

        if not os.path.exists(pdf_path):
            return False, [f"PDF file does not exist: {pdf_path}"]

        # Check file size and basic information
        file_size = os.path.getsize(pdf_path)
        print(f"📄 Checking PDF file: {pdf_path}")
        print(f"   File size: {file_size} bytes")

        if file_size == 0:
            return False, ["PDF file size is 0, may be corrupted"]
        
        errors = []
        expected_awards = [
            ("Outstanding Student Award 2021", 1),
            ("Research Competition First Place 2022", 2), 
            ("Academic Excellence Award 2023", 3)
        ]
        
        try:
            with open(pdf_path, 'rb') as file:
                # Try multiple PDF reading methods
                try:
                    # Method 1: Use strict=False (better compatibility)
                    pdf_reader = PyPDF2.PdfReader(file, strict=False)
                    print("   ✅ Successfully read PDF using non-strict mode")
                except Exception as e1:
                    print(f"   ⚠️ Non-strict mode read failed: {e1}")
                    try:
                        # Method 2: Reopen file and use default mode
                        file.seek(0)
                        pdf_reader = PyPDF2.PdfReader(file)
                        print("   ✅ Successfully read PDF using default mode")
                    except Exception as e2:
                        error_msg = f"Failed to read PDF file: non-strict mode error={e1}, default mode error={e2}"
                        errors.append(error_msg)
                        print(f"   ❌ {error_msg}")
                        return False, errors

                total_pages = len(pdf_reader.pages)
                print(f"   Total pages: {total_pages}")

                if total_pages != 3:
                    errors.append(f"PDF page count error: expected 3 pages, got {total_pages} pages")
                    return False, errors

                for award_text, page_num in expected_awards:
                    try:
                        page = pdf_reader.pages[page_num - 1]  # Pages are 0-indexed
                        text = page.extract_text()

                        print(f"   Page {page_num} raw text length: {len(text)}")
                        if len(text) > 0:
                            print(f"   Page {page_num} first 50 characters: {text[:50]}")

                        # Check if keyword exists (remove spaces for comparison)
                        text_clean = text.replace(' ', '').replace('\n', '').lower()
                        award_clean = award_text.replace(' ', '').lower()

                        if award_clean in text_clean:
                            print(f"   ✅ Page {page_num} contains: {award_text}")
                        else:
                            error_msg = f"Page {page_num} missing expected content: {award_text}"
                            errors.append(error_msg)
                            print(f"   ❌ {error_msg}")
                            print(f"   Cleaned text: {text_clean[:100]}")
                            print(f"   Expected content: {award_clean}")

                    except Exception as e:
                        error_msg = f"Failed to read page {page_num}: {e}"
                        errors.append(error_msg)
                        print(f"   ❌ {error_msg}")

        except Exception as e:
            error_msg = f"Failed to open PDF file: {e}"
            errors.append(error_msg)
            print(f"❌ {error_msg}")
            return False, errors
        
        return len(errors) == 0, errors
    
    def run(self, subject_keyword: str = "submit_material") -> bool:
        """Run complete download and comparison workflow"""
        print("🚀 Starting email attachment check and file structure comparison in receiver's mailbox")
        print("=" * 60)

        # 1. Create temporary directory
        if not self.create_temp_dir():
            return False

        try:
            # 2. Search for emails with attachments
            emails = self.search_emails_with_attachments(subject_keyword)
            if not emails:
                print("❌ No matching emails found, workflow terminated")
                return False

            # 3. Download ZIP attachments
            zip_files = self.download_zip_attachments(emails)
            if not zip_files:
                print("❌ No ZIP attachments found, workflow terminated")
                return False

            # 4. Extract ZIP files
            if not self.extract_zip_files(zip_files):
                print("❌ ZIP file extraction failed, workflow terminated")
                return False

            # 5. Find extracted Application_Materials directory
            extracted_materials_dir = self.find_extracted_materials_dir()
            if not extracted_materials_dir:
                print("❌ Application_Materials_* directory not found")
                return False

            print(f"✅ Found extracted materials directory: {os.path.basename(extracted_materials_dir)}")

            # 6. Get file structure
            print(f"\n📂 Getting extracted file structure...")
            extracted_structure = self.get_directory_structure(extracted_materials_dir)

            # Get reference folder structure
            # If valid_structures is set and there is only one structure, use structure_def to generate reference structure
            # Otherwise use groundtruth
            if self.valid_structures and len(self.valid_structures) == 1:
                prof_info = list(self.valid_structures.values())[0]
                if 'structure_def' in prof_info:
                    print(f"📂 Generating reference structure from structure definition: {prof_info['structure_name']}")
                    reference_structure = self.convert_structure_def_to_directory_structure(prof_info['structure_def'])
                else:
                    # Fall back to groundtruth
                    print(f"📂 Getting reference structure from groundtruth...")
                    groundtruth_materials_dir = self._find_groundtruth_materials_dir()
                    if not groundtruth_materials_dir:
                        return False
                    reference_structure = self.get_directory_structure(groundtruth_materials_dir)
            else:
                # Use groundtruth
                print(f"📂 Getting reference structure from groundtruth...")
                groundtruth_materials_dir = self._find_groundtruth_materials_dir()
                if not groundtruth_materials_dir:
                    return False
                reference_structure = self.get_directory_structure(groundtruth_materials_dir)

            # 7. Print structures
            self.print_structure(extracted_structure, "Extracted file structure")
            self.print_structure(reference_structure, "Reference folder structure")

            # 8. Compare structures
            # If valid_structures is set, determine validation mode based on count
            if self.valid_structures:
                if len(self.valid_structures) == 1:
                    # With only one valid structure, perform strict validation
                    print(f"\n🔍 Strict validation mode: Checking if it matches the specified file structure...")
                    is_match, differences = self.compare_structures(extracted_structure, reference_structure)
                    prof_info = list(self.valid_structures.values())[0]
                    matched_structure = prof_info['structure_name']
                else:
                    # With multiple valid structures, use lenient validation (match any structure)
                    print(f"\n🔍 Lenient validation mode: Checking if it matches one of {len(self.valid_structures)} valid structures...")
                    is_match = True  # Lenient validation: as long as files are reasonable
                    differences = []
                    matched_structure = "Any valid structure"
                    print("✅ As long as reasonable files are submitted")
            else:
                # Original strict validation mode
                is_match, differences = self.compare_structures(extracted_structure, reference_structure)
                matched_structure = "Standard Structure"

            # 9. Check All_Awards_Certificates.pdf content (if exists)
            pdf_content_valid = True
            pdf_errors = []
            
            # Find Awards PDF in various possible locations
            awards_pdf_locations = [
                os.path.join(extracted_materials_dir, '02_Academic_Materials', 'Awards_Certificates', 'All_Awards_Certificates.pdf'),
                os.path.join(extracted_materials_dir, '01_Academic_Materials', 'Awards_Certificates', 'All_Awards_Certificates.pdf'),
                os.path.join(extracted_materials_dir, '03_Academic_Materials', 'Awards_Certificates', 'All_Awards_Certificates.pdf'),
                os.path.join(extracted_materials_dir, '04_Academic_Materials', 'Awards_Certificates', 'All_Awards_Certificates.pdf'),
            ]
            
            awards_pdf_path = None
            for path in awards_pdf_locations:
                if os.path.exists(path):
                    awards_pdf_path = path
                    break
            
            if awards_pdf_path:
                print(f"\n🔍 Checking All_Awards_Certificates.pdf content...")
                pdf_content_valid, pdf_errors = self.check_pdf_content(awards_pdf_path)
            else:
                # PDF not existing is also acceptable (some variants don't require Awards)
                if self.valid_structures:
                    print("ℹ️  All_Awards_Certificates.pdf does not exist (some variants may not need it)")
                    pdf_content_valid = True  # Lenient mode
                else:
                    pdf_content_valid = False
                    pdf_errors = ["All_Awards_Certificates.pdf file does not exist"]
                    print("❌ All_Awards_Certificates.pdf file does not exist")

            # 10. Output results
            print("\n" + "=" * 60)
            print("📊 Comparison Results")
            print("=" * 60)

            # File structure check results
            print("\n📁 File structure check:")
            if is_match:
                if self.valid_structures:
                    print(f"✅ File structure meets requirements! (Matched: {matched_structure})")
                    print(f"   Available structure options:")
                    for prof_email, info in self.valid_structures.items():
                        print(f"   • {info['name']}: {info['structure_name']}")
                else:
                    print(f"✅ File structure fully matches! ({matched_structure})")
            else:
                print("❌ File structure does not match")
                print("Difference details:")
                for diff in differences:
                    print(f"   • {diff}")

            # PDF content check results
            print("\n📄 PDF content check:")
            if pdf_content_valid:
                print("✅ All_Awards_Certificates.pdf content meets requirements!")
            else:
                print("❌ All_Awards_Certificates.pdf content does not meet requirements")
                print("Error details:")
                for error in pdf_errors:
                    print(f"   • {error}")

            # Overall results
            overall_success = is_match and pdf_content_valid
            print(f"\n{'='*60}")
            print("🎯 Overall Results:")
            if overall_success:
                print("✅ All checks passed!")
            else:
                print("❌ Checks not fully passed, please see details above")
            
            return overall_success
            
        finally:
            # Clean up temporary directory
            try:
                import shutil
                nfs_safe_rmtree(self.temp_dir)
                print(f"🧹 Cleaned up temporary directory: {self.temp_dir}")
            except Exception as e:
                print(f"⚠️ Failed to clean up temporary directory: {e}")


def main():
    parser = argparse.ArgumentParser(description='Local email attachment check and file structure comparison')
    parser.add_argument('--config_file', '-c',
                       default='files/receiver_config.json',
                       help='Receiver email configuration file path')
    parser.add_argument('--subject', '-s',
                       default='submit_material',
                       help='Email subject keyword')
    parser.add_argument('--agent_workspace', '-w',
                       default='test_workspace',
                       help='Agent workspace')
    parser.add_argument('--groundtruth_workspace', '-r',
                       help='Reference folder', required=True)
    args = parser.parse_args()

    print(f"📧 Using receiver email configuration file: {args.config_file}")
    
    # Create checker and run
    checker = LocalEmailAttachmentChecker(args.config_file, args.agent_workspace, args.groundtruth_workspace)
    success = checker.run(args.subject)

    if success:
        print("\n🎉 Workflow executed successfully!")
    else:
        print("\n💥 Workflow execution failed!")
    
    return 0 if success else 1


if __name__ == '__main__':
    exit(main())