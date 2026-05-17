"""Set Conference Camera-Ready Deadline S2L Environment.

This environment simulates a conference reminder scenario where an agent needs to:
1. Check emails for camera-ready deadline notifications
2. Identify target conferences from the conference info file
3. Set calendar reminders 3 hours before each deadline
4. Handle reminder emails and deadline extensions

The environment uses Email and Calendar databases to store and verify data.
"""

from gem.envs.set_conf_cr_ddl_s2l.set_conf_cr_ddl_s2l import SetConfCrDdlS2LEnv

__all__ = ['SetConfCrDdlS2LEnv']



