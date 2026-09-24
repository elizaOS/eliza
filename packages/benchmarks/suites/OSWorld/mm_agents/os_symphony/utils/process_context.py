# process_context.py
# This module provides an independent context storage for each process.

from multiprocessing import current_process

# We will store process-specific contexts here.
# Since each process has its own separate memory space, when accessing this variable,
# each process accesses its own copy, without conflicting with others.
_context_storage = {}

def set_context(key, value):
    """Set a value in the context of the current process."""
    _context_storage[key] = value
    # print(f"[{current_process().name}] Set context: {key} = {value}") # For debugging

def get_context(key, default=None):
    """Retrieve a value from the context of the current process."""
    value = _context_storage.get(key, default)
    # print(f"[{current_process().name}] Get context: {key} -> {value}") # For debugging
    if value is None and default is None:
        raise NameError(f"'{key}' not found in the current process context. Ensure it is set at the process entry point.")
    return value

# For convenience, we can create a specialized getter for result_dir
def get_current_result_dir():
    """Get the result_dir specific to the current process."""
    return get_context('current_result_dir')

def set_current_result_dir(example_result_dir):
    set_context("current_result_dir", example_result_dir)