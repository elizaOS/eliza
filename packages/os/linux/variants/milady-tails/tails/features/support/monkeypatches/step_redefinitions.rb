module Cucumber
  # This class is only used when the cucumber --guess option was
  # given, or if that option was enabled dynamically when running
  # reload_code(). We don't care about cucumber's normal guessing
  # since we are careful about not writing ambiguous step patterns
  # so instead we hijack it to resolve ambiguous step definitions
  # after reloading code with that step by using the last one that
  # was loaded.
  class StepMatchSearch::AttemptToGuessAmbiguousMatch
    def best_matches(_step_name, step_matches)
      [step_matches.last]
    end
  end

  # Add support for re-defining steps dynamically during a run. When
  # code is reloaded all steps are instantiated as RbStepDefinition
  # again, but we also have to modify existing instances or else
  # cucumber will use the old definitions since it already has
  # matched each step read from the .feature files to these old
  # instances.
  class RbSupport::RbStepDefinition
    attr_reader :regexp
    attr_accessor :proc
    alias old_initialize initialize

    # We deliberately keep this monkeypatch as non-invasive as
    # possible by hiding the added functionality behind a bool that
    # is only set if reload_code() was ever called, which it isn't
    # during a normal run.
    def initialize(*args, **opts)
      old_initialize(*args, **opts)
      assert_equal(3, args.length, 'Please update the monkeypatch')
      assert_empty(opts, 'Please update the monkeypatch')
      return unless !$cucumber_options.nil? && $cucumber_options[:redefine_steps]

      rb_language, regexp, proc = args
      rb_language.step_definitions.each do |step|
        step.proc = proc if step.regexp == regexp
      end
    end
  end
end
