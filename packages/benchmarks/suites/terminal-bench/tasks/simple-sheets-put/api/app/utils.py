import re
from typing import Tuple


def validate_cell_id(cell_id: str) -> Tuple[bool, str]:
    """
    Validates a cell ID to ensure it follows A1 notation.
    Returns a tuple of (is_valid, error_message).

    Valid examples: A1, B2, Z9, AA1, ZZ999
    Invalid examples: 1A, A0, AAA1, A-1, 11
    """
    # Regular expression for A1 notation
    # Matches one or two uppercase letters followed by one or more digits
    pattern = r"^[A-Z]{1,2}[1-9][0-9]*$"

    if not cell_id:
        return False, "Cell ID cannot be empty"

    if not re.match(pattern, cell_id):
        return False, "Cell ID must be in A1 notation (e.g., A1, B2, AA1)"

    # Extract column letters and row number
    column_str = "".join(c for c in cell_id if c.isalpha())
    row_str = "".join(c for c in cell_id if c.isdigit())

    # Convert column string to number (A=1, B=2, ..., Z=26, AA=27, ...)
    column_num = 0
    for char in column_str:
        column_num = column_num * 26 + (ord(char) - ord("A") + 1)

    # Check if column number is within reasonable bounds (A to ZZ = 1 to 702)
    if column_num > 702:
        return False, "Column identifier too large (maximum is ZZ)"

    # Check if row number is within reasonable bounds (1 to 9999)
    row_num = int(row_str)
    if row_num > 9999:
        return False, "Row number too large (maximum is 9999)"

    return True, ""
