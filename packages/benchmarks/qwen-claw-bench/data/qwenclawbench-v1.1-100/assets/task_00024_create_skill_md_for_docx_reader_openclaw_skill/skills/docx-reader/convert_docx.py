import sys
import docx

# Convert a .docx file to plain text
# Usage: python convert_docx.py input.docx [output.txt]

path = sys.argv[1]
output_path = sys.argv[2] if len(sys.argv) >= 3 else None  # optional output file

doc = docx.Document(path)

output_lines = []
for para in doc.paragraphs:
    output_lines.append(para.text)

result = "\n".join(output_lines)

# TODO: add error handling for missing file or invalid format

print(result)
