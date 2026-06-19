"""
Apply PhD Email S2L Environment

This environment simulates a PhD application scenario where an agent needs to:
1. Read an email from Professor Kaiming with submission instructions
2. Organize application materials from a flat directory structure
3. Process files according to specific requirements:
   - Rename CV.pdf to Resume.pdf
   - Extract professor names from recommendation letter PDFs and rename files
   - Merge award certificates chronologically into a single PDF
4. Retrieve personal information from memory for folder naming
5. Create a ZIP file with the organized materials
6. Send an email with the ZIP attachment to the specified recipient

The task tests the agent's ability to:
- Read and parse email content for instructions
- Perform complex file organization and renaming
- Work with PDF manipulation (reading and merging)
- Access memory for personal information
- Send emails with attachments
"""

from .apply_phd_email_s2l import ApplyPhDEmailS2LEnv

__all__ = ["ApplyPhDEmailS2LEnv"]



