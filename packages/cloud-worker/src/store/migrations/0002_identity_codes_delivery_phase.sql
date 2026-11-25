ALTER TABLE code_challenges
  DROP CONSTRAINT code_challenges_phase_check,
  ADD CONSTRAINT code_challenges_phase_check
    CHECK (phase IN ('unsent', 'open', 'locked', 'consumed', 'superseded', 'expired'));
