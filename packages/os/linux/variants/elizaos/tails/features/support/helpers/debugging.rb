require 'binding_of_caller'
require 'pry'

def binding_display(binding)
  method = binding.eval('__method__')
  instance = binding.eval('self')
  if instance.instance_of?(Object)
    # The top-level Object instance is a mess when displayed,
    # "#<Object+RSpec::Matchers+Cucumber::RbSupport::RbWorld+...>"
    # or similar, so we strip all that.
    instance = '#<Object>'
  end
  what = if method.nil? || method.empty?
           '<top-level>'
         else
           "#{method}()"
         end
  where = binding.source_location.join(':').to_s
  "#{Pry::Helpers::Text.bold(what)} (#{instance}) at #{where}"
end

# rubocop:disable Metrics/CyclomaticComplexity
# rubocop:disable Metrics/PerceivedComplexity
def find_our_caller_binding(bindings, log_skipped: false)
  skipped_bindings = []
  our_caller_binding = bindings.find do |b|
    next if b.nil?

    source_location = b.source_location&.first
    # There are "weird" bindings that do not have source locations,
    # probably some internal implementation detail of Ruby. We are
    # only interested in our code, not code living in modules we
    # import, or code we `include` (like Test::Unit::Assertions).
    next if source_location.nil? || !source_location&.start_with?(GIT_DIR)

    method = b.eval('__method__')

    # We determine which bindings to return by matching against the
    # calling method's name, which could lead to false positives if we
    # ever define methods with the same name in other contexts
    # (e.g. in some class). Therefore we also guard by which file they
    # are defined in.
    # When interactively debugging we rarely are trying to debug
    # various helper methods but rather the context they are called
    # from, so we exempt them below.
    our = case source_location
          when __FILE__
            # Everything in this file is ignored, otherwise we would always
            # return the binding in this method, find_our_caller_binding() or
            # pause().
            false
          when "#{GIT_DIR}/features/step_definitions/snapshots.rb"
            # We ignore the snapshot machinery, otherwise when an error occurs
            # during reach_checkpoint() or one of the generated snapshot steps
            # we end up with those not very interesting contexts.
            false
          when "#{GIT_DIR}/features/support/helpers/dogtail.rb"
            false
          when "#{GIT_DIR}/features/support/helpers/firewall_helper.rb"
            false
          when "#{GIT_DIR}/features/support/helpers/misc_helpers.rb"
            method != :assert_vmcommand_success && \
            method != :cmd_helper && \
            method != :retry_action && \
            method != :retry_tor && \
            method != :try_for
          when "#{GIT_DIR}/features/support/helpers/screen.rb"
            false
          when "#{GIT_DIR}/features/support/helpers/vm_helper.rb"
            method != :execute_successfully
          else
            true
          end
    skipped_bindings << binding_display(b) unless our
    our
  end
  if log_skipped && skipped_bindings.size.positive?
    $stderr.puts
    warn Pry::Helpers::Text.bold(
      '  Helpers were skipped in the stack (above the arrow):'
    )
    $stderr.puts
    skipped_bindings.each do |binding_display|
      warn("     #{binding_display}")
    end
    warn " =>  #{binding_display(our_caller_binding)}"
    warn '     [...]'
  end
  our_caller_binding
end
# rubocop:enable Metrics/CyclomaticComplexity
# rubocop:enable Metrics/PerceivedComplexity

def pause(message = 'Paused', exception: nil, quiet: false)
  notify_user(message)
  $stderr.puts
  warn message
  # Ring the ASCII bell for a helpful notification in most terminal
  # emulators.
  $stdout.write "\a"
  $stderr.puts
  loop do
    warn 'Return/q: Continue; d: Debugging REPL'
    c = $stdin.getch
    case c
    when 'q', "\r", 3.chr # Ctrl+C => 3
      return
    when 'd'
      if exception.nil?
        # pause() was manually called so our caller is in the current
        # binding's stack of caller bindings, provided by the
        # binding_of_caller module.
        caller_bindings = binding.callers
        # When manually adding a pause() breakpoint we log which of
        # our methods we skip in find_our_caller_binding(). This is a
        # nice reminder of which methods we skip in case it is one of
        # them we are debugging and added the breakpoint into.
        log_skipped = true
      else
        # pause() was called for an exception caught by cucumber so
        # our caller is in the binding stack in the exception provided
        # by the bindex module.
        assert(config_bool('INTERACTIVE_DEBUGGING'))
        caller_bindings = exception.bindings
        log_skipped = false
      end
      $caller_bindings = caller_bindings
      our_caller_binding = find_our_caller_binding(caller_bindings, log_skipped:)
      $caller_bindings_index = $caller_bindings.find_index(our_caller_binding)
      if our_caller_binding.nil?
        warn "Warning: could not restore the failure's context"
        $stderr.puts
        quiet = true
        our_caller_binding = binding
      end
      $stderr.puts
      warn <<-MESSAGE
  Use the 'stack' command to see where you are in the stack, and the 'down'
  and 'up' commands to navigate the stack.
      MESSAGE
      our_caller_binding.pry(quiet:)
    end
  end
end

alias breakpoint pause

def pry_navigate_caller_stack(offset, context: 2)
  new_index = $caller_bindings_index + offset
  raise(Pry::CommandError, 'Top of stack reached!') if new_index.negative?

  raise(Pry::CommandError, 'Bottom of stack reached!') \
       if new_index >= $caller_bindings.size

  $caller_bindings_index = new_index
  new_binding = $caller_bindings[$caller_bindings_index]
  if pry_instance.binding_stack.empty?
    pry_instance.binding_stack.replace([new_binding])
  else
    pry_instance.binding_stack[-1] = new_binding
  end
  pry_instance.run_command('whereami')
  warn pry_caller_stack(context:)
end

def pry_caller_stack(context: nil)
  current = $caller_bindings[$caller_bindings_index]
  stack = $caller_bindings.map do |b|
    indicator = b == current ? '=>' : '  '
    "#{indicator} #{binding_display(b)}"
  end
  unless context.nil?
    current_stack_index = stack.find_index { |s| s.start_with?('=>') }
    orig_stack_size = stack.size
    stack = stack[
      [0, current_stack_index - context].max,
      2 * context + 1
    ]
    if context < current_stack_index
      stack = ['   [...]'] + stack
    end
    if current_stack_index + context + 1 < orig_stack_size
      stack += ['   [...]']
    end
  end
  message = bold('Stack: <method> (<instance>) at <source location>')
  message += "\n  "
  message + stack.join("\n  ")
end

StackCommands = Pry::CommandSet.new do
  create_command('up', 'Move up in the call stack') do
    def process
      pry_navigate_caller_stack(-1)
    end
  end

  create_command('down', 'Move down in the call stack') do
    def process
      pry_navigate_caller_stack(1)
    end
  end

  create_command('stack', 'Print the stack') do
    def process
      stagger_output(pry_caller_stack)
    end
  end
end

StackCommands.each { |_, command| command.group('Stack navigation') }

Pry.config.commands.import(StackCommands)
