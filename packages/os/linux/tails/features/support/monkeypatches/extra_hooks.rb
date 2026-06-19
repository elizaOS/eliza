# rubocop:disable Style/Documentation

# Now that we stopped supporting Cucumber<2.0, we could probably do
# this differently.

unless defined? SCENARIO_INDENT
  SCENARIO_INDENT = (' ' * 4).freeze
  STEP_INDENT = (' ' * 6).freeze
  SUBSTEP_INDENT = (' ' * 8).freeze

  begin
    unless Cucumber::Core::Ast::Feature.instance_methods.include?(:accept_hook?)
      require 'cucumber/core/gherkin/tag_expression'
      class Cucumber::Core::Ast::Feature
        # Code inspired by Cucumber::Core::Test::Case.match_tags?() in
        # cucumber-ruby-core 1.1.3, lib/cucumber/core/test/case.rb:~59.
        def accept_hook?(hook)
          tag_expr = Cucumber::Core::Gherkin::TagExpression
                     .new(hook.tag_expressions.flatten)
          tag_expr.evaluate(@tags)
        end
      end
    end
  rescue NameError => e
    raise e if e.to_s != 'uninitialized constant Cucumber::Core'
  end

  # Sort of inspired by Cucumber::RbSupport::RbHook (from cucumber
  # < 2.0) but really we just want an object with a 'tag_expressions'
  # attribute to make accept_hook?() (used below) happy.
  class SimpleHook
    attr_reader :tag_expressions

    def initialize(tag_expressions, proc)
      @tag_expressions = tag_expressions
      @proc = proc
    end

    def invoke(arg)
      @proc.call(arg)
    end
  end

  def BeforeFeature(*tag_expressions, &block)
    $before_feature_hooks ||= []
    $before_feature_hooks << SimpleHook.new(tag_expressions, block)
  end

  def AfterFeature(*tag_expressions, &block)
    $after_feature_hooks ||= []
    $after_feature_hooks << SimpleHook.new(tag_expressions, block)
  end

  require 'cucumber/formatter/console'
  unless $at_exit_print_artifacts_dir_patching_done
    module Cucumber::Formatter::Console
      alias old_print_stats print_stats if method_defined?(:print_stats)
      def print_stats(...)
        @io.puts "Artifacts directory: #{ARTIFACTS_DIR}"
        @io.puts
        @io.puts "Debug log:           #{ARTIFACTS_DIR}/debug.log"
        @io.puts
        old_print_stats(...) if self.class.method_defined?(:old_print_stats)
      end

      STATUS_STR = {
        passed:    'passed',
        failed:    'failed',
        undefined: 'undefined',
        pending:   'pending',
        skipped:   'skipped',
      }.freeze
      private_constant :STATUS_STR

      # Support printing the step status. For the original function body,
      # see https://salsa.debian.org/ruby-team/cucumber/-/blob/9899bc47c0eac62b623208f5e8032ec7285fe257/lib/cucumber/formatter/console.rb#L33-44
      alias old_format_step format_step
      def format_step(keyword, step_match, status, source_indent, print_status: false)
        comment = if source_indent
                    c = "# #{step_match.location}".indent(source_indent)
                    format_string(c, :comment)
                  else
                    ''
                  end

        format = format_for(status, :param)
        status_suffix = print_status ? " (#{STATUS_STR[status]})" : ''
        line = keyword + step_match.format_args(format) + status_suffix + comment
        format_string(line, status)
      end
    end
    $at_exit_print_artifacts_dir_patching_done = true
  end

  def log_scenario(message, **options)
    options[:color] = :white unless options.key?(:color)
    options[:timestamp] = false unless options.key?(:timestamp)
    debug_log(SCENARIO_INDENT + message, **options)
  end

  def log_step_succeeded(message, **options)
    options[:color] = :green unless options.key?(:color)
    options[:timestamp] = false unless options.key?(:timestamp)
    debug_log("#{STEP_INDENT}#{message} (passed)", **options)
  end

  def log_step_failed(message, **options)
    options[:color] = :red unless options.key?(:color)
    options[:timestamp] = false unless options.key?(:timestamp)
    debug_log("#{STEP_INDENT}#{message} (failed)", **options)
  end

  def log_substep(message, **options)
    debug_log(SUBSTEP_INDENT + message, **options)
  end

  require 'cucumber/formatter/pretty'

  module ExtraFormatters
    # This is a null formatter in the sense that it doesn't ever output
    # anything. We only use it do hook into the correct events so we can
    # add our extra hooks.
    class ExtraHooks
      def initialize(runtime, io, options) # rubocop:disable Naming/MethodParameterName
        # We do not care about any of the arguments.
        # XXX: We should be able to just have `*args` for the arguments
        # in the prototype, but since moving to cucumber 2.4 that breaks
        # this formatter for some unknown reason.
      end

      def before_feature(feature)
        return unless $before_feature_hooks

        $before_feature_hooks.each do |hook|
          hook.invoke(feature) if feature.accept_hook?(hook)
        end
      end

      def after_feature(feature)
        return unless $after_feature_hooks

        $after_feature_hooks.reverse.each do |hook|
          hook.invoke(feature) if feature.accept_hook?(hook)
        end
      end
    end

    # The pretty formatter with debug logging mixed into its output.
    class PrettyDebug < Cucumber::Formatter::Pretty
      def initialize(runtime, io, options) # rubocop:disable Naming/MethodParameterName
        super(runtime, io, options)
        $debug_log_fns ||= []
        $debug_log_fns << method(:debug_log)
      end

      def debug_log(message, **options)
        options[:color] ||= :cyan
        @io.puts(format_string(message, options[:color]))
        @io.flush
      end

      # Print the status after the step name (useful for build tools which
      # parse the logs). For the original function body,
      # see https://salsa.debian.org/ruby-team/cucumber/-/blob/9899bc47c0eac62b623208f5e8032ec7285fe257/lib/cucumber/formatter/pretty.rb#L149-155
      def step_name(keyword, step_match, status, source_indent, ...)
        return if @hide_this_step

        source_indent = nil unless @options[:source]
        name_to_report = format_step(keyword, step_match, status, source_indent,
                                     print_status: true)
        @io.puts(name_to_report.indent(@scenario_indent + 2))
        print_messages
      end

      # Recursively print the exception and all previous exceptions
      def print_exception(exc, status, indent)
        super(exc, status, indent)
        if exc.cause
          cause = Cucumber::Formatter::BacktraceFilter.new(exc.cause.dup).exception
          print_exception(cause, status, indent)
        end
      end
    end
  end

  class Cucumber::Cli::Options
    BUILTIN_FORMATS['pretty_debug'] =
      [
        'ExtraFormatters::PrettyDebug',
        'Prints the feature with debugging information - in colours.',
      ]
    BUILTIN_FORMATS['debug'] = BUILTIN_FORMATS['pretty_debug']
  end

  AfterConfiguration do |config|
    # Cucumber may read this file multiple times, and hence run this
    # AfterConfiguration hook multiple times. We only want our
    # ExtraHooks formatter to be loaded once, otherwise the hooks would
    # be run multiple times.
    extra_hooks = [
      ['ExtraFormatters::ExtraHooks', '/dev/null'],
      ['Cucumber::Formatter::Pretty', "#{ARTIFACTS_DIR}/pretty.log"],
      ['Cucumber::Formatter::Json', "#{ARTIFACTS_DIR}/cucumber.json"],
      ['ExtraFormatters::PrettyDebug', "#{ARTIFACTS_DIR}/debug.log"],
      ['Cucumber::Formatter::Rerun', "#{ARTIFACTS_DIR}/rerun.txt"],
    ]
    extra_hooks.each do |hook|
      config.formats << hook unless config.formats.include?(hook)
    end
  end
end

# rubocop:enable Style/Documentation
