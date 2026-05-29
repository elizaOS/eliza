# Extracts the secrets for the XMPP account `account_name`.
def xmpp_account(account_name)
  begin
    account = $config['Pidgin']['Accounts']['XMPP'][account_name]
    check_keys = ['username', 'domain', 'password']
    check_keys.each do |key|
      assert(account.key?(key))
      assert_not_nil(account[key])
      assert(!account[key].empty?)
    end
  rescue NoMethodError, Test::Unit::AssertionFailedError
    raise(
      "Your Pidgin:Accounts:XMPP:#{account} is incorrect or missing " \
      "from your local configuration file (#{LOCAL_CONFIG_FILE}). " \
      'See wiki/src/contribute/release_process/test/usage.mdwn for the format.'
    )
  end
  account
end

# Only works for XWayland apps due to use of xdotool
def select_virtual_desktop(desktop_number, user: LIVE_USER)
  assert(desktop_number >= 0 && desktop_number <= 3,
         'Only values between 0 and 1 are valid virtual desktop numbers')
  $vm.execute_successfully(
    "xdotool set_desktop '#{desktop_number}'",
    user:
  )
end

# Only works for XWayland apps due to use of xdotool
def focus_window(window_title, user: LIVE_USER)
  do_focus = lambda do
    $vm.execute_successfully(
      "xdotool search --name '#{window_title}' windowactivate --sync",
      user:
    )
  end

  begin
    do_focus.call
  rescue ExecutionFailedInVM
    # Often when xdotool fails to focus a window it'll work when retried
    # after redrawing the screen.  Switching to a new virtual desktop then
    # back seems to be a reliable way to handle this.
    # Sadly we have to rely on a lot of sleep() here since there's
    # little on the screen etc that we truly can rely on.
    sleep 5
    select_virtual_desktop(1)
    sleep 5
    select_virtual_desktop(0)
    sleep 5
    do_focus.call
  end
rescue StandardError
  # noop
end

def wait_and_focus(img, window, time = 10)
  @screen.wait(img, time)
rescue FindFailed
  focus_window(window)
  @screen.wait(img, time)
end

# This method should always fail (except with the option
# `return_shellcommand: true`) since we block Pidgin's D-Bus interface
# (#14612) ...
def pidgin_dbus_call(method, *args, **opts)
  opts[:user] = LIVE_USER
  dbus_send(
    'im.pidgin.purple.PurpleService',
    '/im/pidgin/purple/PurpleObject',
    "im.pidgin.purple.PurpleInterface.#{method}",
    *args, **opts
  )
end

# ... unless we re-enable it!
def pidgin_force_allowed_dbus_call(method, *args, **opts)
  opts[:user] = LIVE_USER
  policy_file = '/etc/dbus-1/session.d/im.pidgin.purple.PurpleService.conf'
  $vm.execute_successfully("mv #{policy_file} #{policy_file}.disabled")
  # From dbus-daemon(1): "Policy changes should take effect with SIGHUP"
  # Note that HUP is asynchronous, so there is no guarantee whatsoever
  # that the HUP will take effect before we do the dbus call. In
  # practice, however, the delays imposed by using the remote shell is
  # (in general) much larger than the processing time needed for
  # handling signals, so they are in effect synchronous in our
  # context.
  $vm.execute_successfully("pkill -HUP -u #{opts[:user]} 'dbus-daemon'")
  pidgin_dbus_call(method, *args, **opts)
ensure
  $vm.execute_successfully("mv #{policy_file}.disabled #{policy_file}")
  $vm.execute_successfully("pkill -HUP -u #{opts[:user]} 'dbus-daemon'")
end

def pidgin_account_connected?(account, prpl_protocol)
  account_id = pidgin_force_allowed_dbus_call(
    'PurpleAccountsFind', account, prpl_protocol
  )
  pidgin_force_allowed_dbus_call('PurpleAccountIsConnected', account_id) == 1
end

def mid_right_edge(pattern, **opts)
  m = @screen.find(pattern, **opts)
  [m.x + m.w, m.y + m.h / 2]
end

def click_mid_right_edge(pattern, **opts)
  target = mid_right_edge(pattern, **opts)
  @screen.click(target[0], target[1])
end

When /^I create my XMPP account$/ do
  account = xmpp_account('Tails_account')
  @screen.click('PidginAccountManagerAddButton.png')
  @screen.wait('PidginAddAccountWindow.png', 20)
  @screen.wait('PidginAddAccountProtocolLabel.png', 20)
  click_mid_right_edge('PidginAddAccountProtocolLabel.png')
  @screen.wait('PidginAddAccountProtocolXMPP.png', 20).click
  # We first wait for some field that is shown for XMPP but not the
  # default (IRC) since we otherwise may decide where we click before
  # the GUI has updated after switching protocol.
  @screen.wait('PidginAddAccountXMPPDomain.png', 5)
  click_mid_right_edge('PidginAddAccountXMPPUsername.png')
  @screen.paste(account['username'])
  click_mid_right_edge('PidginAddAccountXMPPDomain.png')
  @screen.paste(account['domain'])
  click_mid_right_edge('PidginAddAccountXMPPPassword.png')
  @screen.paste(account['password'])
  @screen.click('PidginAddAccountXMPPRememberPassword.png')
  if account['connect_server']
    @screen.click('PidginAddAccountXMPPAdvancedTab.png')
    click_mid_right_edge('PidginAddAccountXMPPConnectServer.png')
    @screen.paste(account['connect_server'])
  end
  @screen.click('PidginAddAccountXMPPAddButton.png')
end

Then /^Pidgin automatically enables my XMPP account$/ do
  account = xmpp_account('Tails_account')
  jid = "#{account['username']}@#{account['domain']}"
  try_for(3 * 60) do
    pidgin_account_connected?(jid, 'prpl-jabber')
  end
  focus_window('Buddy List')
  @screen.wait('PidginAvailableStatus.png', 60 * 3)
end

Given /^my XMPP friend goes online$/ do
  account = xmpp_account('Friend_account')
  bot_opts = account.select { |k, _| ['connect_server'].include?(k) }
  @friend_name = account['username']
  @chatbot = ChatBot.new(
    "#{account['username']}@#{account['domain']}",
    account['password'],
    **bot_opts.transform_keys(&:to_sym)
  )
  @chatbot.start
  add_after_scenario_hook { @chatbot.stop }
  focus_window('Buddy List')
  begin
    @screen.wait('PidginFriendOnline.png', 60)
  rescue FindFailed
    raise 'Known issue #21440: XMPP friend failed to go online'
  end
end

When /^I start a conversation with my friend$/ do
  focus_window('Buddy List')
  # Clicking the middle, bottom of this image should query our
  # friend, given it's the only subscribed user that's online, which
  # we assume.
  r = @screen.find('PidginFriendOnline.png')
  x = r.x + r.w / 2
  y = r.y + r.h
  @screen.click(x, y, double: true)
  # If we keep the mouse hovering over the friend there's a tooltip
  # that might obscure the conversation window we just opened
  @screen.hide_cursor
  # Since Pidgin sets the window name to the contact, we have no good
  # way to identify the conversation window. Let's just look for the
  # expected menu bar.
  @screen.wait('PidginConversationWindowMenuBar.png', 10)
end

And /^I say (.*) to my friend$/ do |msg|
  msg = 'ping' if msg == 'something'
  focus_window(@friend_name)
  @screen.paste(msg)
  @screen.press('Return')
end

Then /^I receive a response from my friend$/ do
  focus_window(@friend_name)
  try_for(60) do
    if @screen.exists?('PidginServerMessage.png')
      @screen.click('PidginDialogCloseButton.png')
    end
    @screen.find('PidginFriendExpectedAnswer.png')
  end
end

def configured_pidgin_accounts
  accounts = {}
  xml = REXML::Document.new(
    $vm.file_content("/home/#{LIVE_USER}/.purple/accounts.xml")
  )
  xml.elements.each('account/account') do |e|
    account = e.elements['name'].text
    account_name, network = account.split('@')
    protocol = e.elements['protocol'].text
    port = e.elements["settings/setting[@name='port']"].text
    username_element = e.elements["settings/setting[@name='username']"]
    realname_elemenet = e.elements["settings/setting[@name='realname']"]
    nickname = username_element ? username_element.text : nil
    real_name = realname_elemenet ? realname_elemenet.text : nil
    accounts[network] = {
      'name'      => account_name,
      'network'   => network,
      'protocol'  => protocol,
      'port'      => port,
      'nickname'  => nickname,
      'real_name' => real_name,
    }
  end

  accounts
end

When /^I see Pidgin's account manager window$/ do
  @screen.wait('PidginAccountWindow.png', 40)
end

When /^I close Pidgin's account manager window$/ do
  @screen.wait('PidginDialogCloseButton.png', 10).click
end

When /^I close Pidgin$/ do
  focus_window('Buddy List')
  @screen.press('ctrl', 'q')
  @screen.wait_vanish('PidginAvailableStatus.png', 10)
end

Then /^I take note of the configured Pidgin accounts$/ do
  @persistent_pidgin_accounts = configured_pidgin_accounts
end

Then /^Pidgin has the expected persistent accounts configured$/ do
  current_accounts = configured_pidgin_accounts
  assert(
    current_accounts <=> @persistent_pidgin_accounts,
    "Currently configured Pidgin accounts do not match the persistent ones:\n" \
    "Current:\n#{current_accounts}\n" \
    "Persistent:\n#{@persistent_pidgin_accounts}"
  )
end

Then /^Pidgin's D-Bus interface is not available$/ do
  # Pidgin must be running to expose the interface
  assert($vm.process_running?('pidgin'))
  # Let's first ensure it would work if not explicitly blocked.
  # Note: that the method we pick here doesn't really matter
  # (`PurpleAccountsGetAll` felt like a convenient choice since it
  # doesn't require any arguments).
  assert_equal(
    Array, pidgin_force_allowed_dbus_call('PurpleAccountsGetAll').class
  )
  # Finally, let's make sure it is blocked
  c = pidgin_dbus_call('PurpleAccountsGetAll', return_shellcommand: true)
  assert(c.failure?)
  assert_not_nil(c.stderr['Rejected send message'])
end
