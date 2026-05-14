module Dogtail
  LEFT_CLICK = 1
  MIDDLE_CLICK = 2
  RIGHT_CLICK = 3

  private_constant :LEFT_CLICK
  private_constant :MIDDLE_CLICK
  private_constant :RIGHT_CLICK

  class Failure < StandardError
  end

  # We want to keep this class immutable so that handles always are
  # left intact when doing new (proxied) method calls.  This way we
  # can support stuff like:
  #
  #     app = Dogtail::Application.new('org.gnome.Evince')
  #     button = app.child('File options', roleName: 'toggle button')
  #     button.click()
  #     button.something_else()
  #     button.click()
  #
  # i.e. the object referenced by `menu` is never modified by method
  # calls and can be used as expected.

  class Application
    @@node_counter ||= 0

    def initialize(app_name, **opts)
      @var = "node#{@@node_counter += 1}"
      @app_name = app_name
      @opts = opts
      @opts[:user] ||= LIVE_USER
      @opts[:retry] = true unless @opts.key?(:retry)

      @find_code = if @opts[:retry] == false
                     "dogtail.tree.root.application('#{@app_name}', retry=False)"
                   else
                     "dogtail.tree.root.application('#{@app_name}')"
                   end

      init = []
      if @opts[:user] == LIVE_USER
        cmd = 'dbus-send --print-reply=literal --session ' \
              '--dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress'
        c = RemoteShell::ShellCommand.new($vm, cmd, user:      @opts[:user],
                                                    debug_log: false)
        if c.returncode != 0
          raise Failure, "dbus-send exited with exit code #{c.returncode}"
        end

        a11y_bus = c.stdout.strip
        init = [
          'import os',
          "os.environ['AT_SPI_BUS_ADDRESS'] = '#{a11y_bus}'",
        ]
      end

      init += [
        'import dogtail.tree',
        'import dogtail.predicate',
        'import dogtail.config',
        'dogtail.config.config.searchShowingOnly = True',
        'dogtail.config.config.logDebugToFile = False',
        'dogtail.config.config.logDebugToStdOut = False',
      ]
      code = [
        "#{@var} = #{@find_code}",
      ]
      run(code, init:)
    end

    def to_s
      @var
    end

    def run(code, init: nil)
      if init
        init = init.join("\n") if init.instance_of?(Array)
        c = RemoteShell::PythonCommand.new($vm, init, user:      @opts[:user],
                                                      debug_log: false)
        if c.failure?
          msg = 'The Dogtail init script raised: ' \
                "#{c.exception}\nSTDOUT:\n#{c.stdout}\nSTDERR:\n#{c.stderr}\n"
          raise Failure, msg
        end
      end
      code = code.join("\n") if code.instance_of?(Array)
      c = RemoteShell::PythonCommand.new($vm, code, user: @opts[:user])
      if c.failure?
        msg = 'The Dogtail init script raised: ' \
              "#{c.exception}\nSTDOUT:\n#{c.stdout.strip}\nSTDERR:\n#{c.stderr.strip}\n"
        raise Failure, msg
      end

      c
    end

    def child?(*args, **options)
      !child(*args, **options).nil?
    rescue StandardError
      false
    end

    def exist?
      run('dogtail.config.config.searchCutoffCount = 0')
      run(@find_code)
      true
    rescue StandardError
      false
    ensure
      run('dogtail.config.config.searchCutoffCount = 20')
    end

    def self.value_to_s(value)
      if value.nil?
        'None'
      elsif value == true
        'True'
      elsif value == false
        'False'
      elsif [String, Regexp].include?(value.class)
        s = value
        if value.instance_of?(Regexp)
          # All Regexp instances explicitly disable the "mix" flags, so
          # to_s() returns "(?-mix:$PATTERN)". Unfortunately Dogtail's
          # regex matching does not support groups since all parentheses
          # in the expression are escaped but source() returns just the
          # original pattern as a string.
          s = value.source
        end
        # Since we use single-quote the string we have to escape any
        # occurrences inside.
        # We also prefix the string with 'r' to make it a raw string,
        # which means we don't have to escape backslashes.
        "r'#{s.gsub("'", "\\\\'")}'"
      elsif [Integer, Float].include?(value.class)
        value.to_s
      else
        raise "#{name} does not know how to handle argument type " \
              "'#{value.class}'"
      end
    end

    # Generates a Python-style parameter list from `args` and `kwargs`.
    # In the end, the resulting string should be possible to copy-paste
    # into the parentheses of a Python function call.
    # Example: 42, :foo: 'bar' => "42, foo = 'bar'"
    def self.args_to_s(*args, **kwargs)
      (
        args.map   { |e| value_to_s(e) } +
        kwargs.map { |k, v| "#{k}=#{value_to_s(v)}" }
      ).join(', ')
    end

    # Equivalent to the Tree API's Node.findChildren(), with the
    # arguments constructing a GenericPredicate to use as parameter.
    def children(*args, **kwargs)
      non_predicates = [:recursive, :showingOnly]
      findChildren_opts_hash = {}
      non_predicates.each do |opt|
        if kwargs.key?(opt)
          findChildren_opts_hash[opt] = kwargs[opt]
          kwargs.delete(opt)
        end
      end
      findChildren_opts = ''
      unless findChildren_opts_hash.empty?
        findChildren_opts = ", #{self.class.args_to_s(**findChildren_opts_hash)}"
      end
      predicate_opts = self.class.args_to_s(*args, **kwargs)
      nodes_var = "nodes#{@@node_counter += 1}"
      find_script_lines = [
        "#{nodes_var} = #{@var}.findChildren(" \
        'dogtail.predicate.GenericPredicate(' \
        "#{predicate_opts})#{findChildren_opts})",
        "print(len(#{nodes_var}))",
      ]
      size = run(find_script_lines).stdout.chomp.to_i
      size.times.map do |i|
        Node.new("#{nodes_var}[#{i}]", **@opts)
      end
    end

    def focused_child
      node_var = "node#{@@node_counter += 1}"
      find_script_lines = [
        'class IsFocused(dogtail.predicate.Predicate):',
        '    def __init__(self):',
        '        self.satisfiedByNode = lambda node: node.focused',
        '    def describeSearchResult(self):',
        "        return 'focused'",
        '',
        "#{node_var} = #{@var}.findChild(IsFocused(), recursive=True)",
      ]
      run(find_script_lines)
      Node.new(node_var.to_s, **@opts)
    end

    def methods
      run("print('\t'.join(dir(#{@var})))").stdout.chomp.split("\t")
    end

    def get_field(key)
      run("print(#{@var}.#{key})").stdout.chomp
    end

    def set_field(key, value)
      run("#{@var}.#{key} = #{self.class.value_to_s(value)}")
    end

    def actions
      get_field('actions').scan(/['"]([^'"]+)['"]/).flatten
    end

    def combovalue
      get_field('combovalue')
    end

    def combovalue=(value)
      set_field('combovalue', value)
    end

    def checked?
      get_field('checked') == 'True'
    end

    def focused?
      get_field('focused') == 'True'
    end

    def selected?
      get_field('selected') == 'True'
    end

    def sensitive?
      get_field('sensitive') == 'True'
    end

    def text
      get_field('text')
    end

    def text=(value)
      set_field('text', value)
    end

    def name
      get_field('name')
    end

    def roleName
      get_field('roleName')
    end

    def showing?
      get_field('showing') == 'True'
    end

    def call_tree_api_method(method, *args, **kwargs)
      orig_arg = args[0]
      args[0] = translate(args[0], **@opts) if args[0].instance_of?(String)
      if args[0] != orig_arg
        debug_log("Translated '#{orig_arg}' to '#{args[0]}'")
      end
      args_str = self.class.args_to_s(*args, **kwargs)
      method_call = "#{method}(#{args_str})"
      Node.new("#{@var}.#{method_call}", **@opts)
    end

    def button(*args, **kwargs)
      call_tree_api_method('button', *args, **kwargs)
    end

    def child(*args, **kwargs)
      call_tree_api_method('child', *args, **kwargs)
    end

    def childLabelled(*args, **kwargs)
      call_tree_api_method('childLabelled', *args, **kwargs)
    end

    def childNamed(*args, **kwargs)
      call_tree_api_method('childNamed', *args, **kwargs)
    end

    def menu(*args, **kwargs)
      call_tree_api_method('menu', *args, **kwargs)
    end

    def menuItem(*args, **kwargs)
      call_tree_api_method('menuItem', *args, **kwargs)
    end

    def panel(*args, **kwargs)
      call_tree_api_method('panel', *args, **kwargs)
    end

    def tab(*args, **kwargs)
      call_tree_api_method('tab', *args, **kwargs)
    end

    def textentry(*args, **kwargs)
      call_tree_api_method('textentry', *args, **kwargs)
    end

    def dialog(*args, **kwargs)
      call_tree_api_method('dialog', *args, **kwargs)
    end

    def window(*args, **kwargs)
      call_tree_api_method('window', *args, **kwargs)
    end

    def labelee
      Node.new("#{@var}.labelee", **@opts)
    end

    def parent
      Node.new("#{@var}.parent", **@opts)
    end

    def get_text_selection_range(**_kwargs)
      # Assumes there is only one text selection
      run("#{@var}.queryText().getSelection(0)")
        .stdout.chomp
        .match(/\((\d+), (\d+)\)/).captures.map(&:to_i)
    end
  end

  class Node < Application
    # rubocop:disable Lint/MissingSuper
    def initialize(expr, **opts)
      @expr = expr
      @opts = opts
      @opts[:user] ||= LIVE_USER
      @find_code = expr
      @var = "node#{@@node_counter += 1}"
      run("#{@var} = #{@find_code}")
    end
    # rubocop:enable Lint/MissingSuper

    def call_tree_node_method(method, *args, **kwargs)
      args_str = self.class.args_to_s(*args, **kwargs)
      method_call = "#{method}(#{args_str})"
      run("#{@var}.#{method_call}")
    end

    def click(force_tree_api: false)
      # The tree API doesn't always work, so we first try any of the
      # actions that a click would trigger.
      unless force_tree_api
        preferred_actions = ['click', 'activate', 'open', 'press', 'select', 'toggle']
        actions.each do |action|
          if preferred_actions.include?(action)
            return doActionNamed(action)
          end
        end
      end
      call_tree_api_method('click')
    end

    def doActionNamed(action_name)
      call_tree_node_method('doActionNamed', action_name)
    end

    def grabFocus
      # We have seen grabFocus return before the node is focused,
      # leading to race conditions, so let's block until the node is
      # actually focused.
      try_for(10) do
        call_tree_node_method('grabFocus')
        focused?
      end
    end

    def activate
      doActionNamed('activate')
    end

    def open
      doActionNamed('open')
    end

    def press
      doActionNamed('press')
    end

    def select
      doActionNamed('select')
    end

    def toggle
      doActionNamed('toggle')
    end

    def position
      get_field('position')[1...-1].split(', ').map(&:to_i)
    end

    def print_parents
      nodes = []
      current = self
      until current.roleName == 'desktop frame'
        nodes << current
        current = current.parent
      end
      max_roleName_length = nodes.map { |n| n.roleName.length }.max
      warn(
        nodes.reverse
             .map { |n| "  #{n.roleName.rjust(max_roleName_length)}: '#{n.name}'" }
             .join("\n")
      )
    end
  end
end
