def browser
  Dogtail::Application.new('Firefox')
end

def desktop_portal_save_as(filename: nil, directory: nil, bookmark: false)
  dialog = nil
  try_for(30) do
    dialog = Dogtail::Application.new('org.gnome.Nautilus').child(roleName: 'frame')
    true
  end
  # Enter the output filename in the initially focused text entry
  dialog.child('File Name', roleName: 'text').text = filename unless filename.nil?
  unless directory.nil?
    if bookmark
      dialog.child('Sidebar', roleName: 'list')
            .child(directory, roleName: 'list item')
            .click
    else
      # Enter the output directory in its text entry
      @screen.press('ctrl', 'l')
      # The keyboard shortcut focuses the text entry we want to input
      # the directory path into, but there's an annoying issue if we also
      # inputted a filename in the other text entry earlier; if we did the
      # other text entry is still focused for a short time, and it loses
      # its "File Name" name and thus becomes very similar to the text
      # entry we now want to interact with, making it difficult to
      # distinguish the two. We do know that the entry we want is
      # positioned pretty high up in the dialog, so we distinguish them
      # like that.
      try_for(10) { dialog.focused_child.position.last < 50 }
      dialog.focused_child.text = directory
      @screen.press('enter')
    end
  end
  dialog.child('Save', roleName: 'button').click
end

def browser_save_page_as(*args, **opts)
  browser.child(
    description: 'Open application menu',
    roleName:    'button'
  ).press
  browser.child(
    name:     'Save page as\u2026',
    roleName: 'button'
  ).press
  desktop_portal_save_as(*args, **opts)
end

def browser_url_entry
  # Unfortunately the Dogtail nodes' names are also translated, so for
  # non-English we have to use a less efficient and (potentially) less
  # future-proof way to find the URL entry.
  if $language.empty? # English
    browser.child('Navigation', roleName: 'tool bar')
           .child(roleName: 'entry')
  else
    browser.children(roleName: 'tool bar')
           .find { |n| n.child?(roleName: 'entry', retry: false) }
           .child(roleName: 'entry')
  end
end

# Get the URL that is currently opened in Tor Browser. If
# as_displayed is true, returns the URL as displayed by the Tor
# Browser. The most important effect is that https:// is omitted.
# Else (the default) it will return the actual URL
def get_current_browser_url(as_displayed: false)
  address = browser_url_entry.text
  if address.empty? || address.start_with?('about:')
    return address
  end

  if !as_displayed && !(address['://'])
    address = "https://#{address}"
  end
  address
end

def set_browser_url(url)
  browser_url_entry.grabFocus
  try_for(10) do
    focused = browser.focused_child
    # Just matching against any entry could be racy if some other
    # entry had focus when calling this step, but address bar is
    # probably the only entry inside a tool bar.
    focused.roleName == 'entry' && focused.parent.parent.parent.roleName == 'tool bar'
  end
  # We're retrying to workaround #19237.
  #
  # Dogtail's .text= would be a simpler and more robust workaround,
  # but we can't use it yet due to
  # https://bugzilla.mozilla.org/show_bug.cgi?id=1861026
  retry_action(10) do
    @screen.press('ctrl', 'a')
    _, selection_length = browser_url_entry.get_text_selection_range
    assert_equal(get_current_browser_url(as_displayed: true).length, selection_length)
    @screen.press('backspace')
    assert_true(get_current_browser_url.empty?)
    @screen.paste(url)
    assert_equal(get_current_browser_url(as_displayed: true), url)
  end
end

When /^I (try to )?start the Unsafe Browser$/ do |try_to|
  launch_unsafe_browser(check_started: !try_to)
end

When /^I successfully start the Unsafe Browser$/ do
  step 'I start the Unsafe Browser'
  step 'the Unsafe Browser has started'
end

# This step works reliably only when there's no more than one tab:
# otherwise, browser.tabs.warnOnClose will block this with a
# "Quit and close tabs?" dialog.
When /^I close the (?:Tor|Unsafe) Browser$/ do
  @screen.press('ctrl', 'q')
end

When(/^I kill the ((?:Tor|Unsafe) Browser)$/) do |browser|
  info = xul_application_info(browser)
  $vm.execute_successfully("pkill --full --exact '#{info[:cmd_regex]}'")
  try_for(10) do
    $vm.execute("pgrep --full --exact '#{info[:cmd_regex]}'").failure?
  end

  # Ugly fix to #18568; in my local testing, 3 seconds are always needed.
  # Let's add some more.
  # A better solution would be to wait until GNOME "received" the fact
  # that the browser has gone away.
  sleep 5
end

def tor_browser_application_info(defaults)
  user = LIVE_USER
  binary = $vm.execute_successfully(
    'echo ${TBB_INSTALL}/firefox.real', libs: 'tor-browser'
  ).stdout.chomp
  cmd_regex = "#{binary} .* -profile " \
              "/home/#{user}/\.tor-browser/profile\.default( .*)?"
  defaults.merge(
    {
      user:,
      cmd_regex:,
      chroot:                          '',
      new_tab_button_image:            'TorBrowserNewTabButton.png',
      browser_reload_button_image:     'TorBrowserReloadButton.png',
      browser_reload_button_image_rtl: 'TorBrowserReloadButtonRTL.png',
      browser_stop_button_image:       'TorBrowserStopButton.png',
    }
  )
end

def unsafe_browser_application_info(defaults)
  user = LIVE_USER
  binary = $vm.execute_successfully(
    'echo ${TBB_INSTALL}/firefox.unsafe-browser', libs: 'tor-browser'
  ).stdout.chomp
  cmd_regex = "#{binary} .* " \
              "--profile /home/#{user}/\.unsafe-browser/profile\.default( .*)?"
  defaults.merge(
    {
      user:,
      cmd_regex:,
      chroot:                      '/var/lib/unsafe-browser/chroot',
      new_tab_button_image:        'UnsafeBrowserNewTabButton.png',
      browser_reload_button_image: 'UnsafeBrowserReloadButton.png',
      browser_stop_button_image:   'UnsafeBrowserStopButton.png',
    }
  )
end

def xul_application_info(application)
  defaults = {
    address_bar_image: "BrowserAddressBar#{$language}.png",
    unused_tbb_libs:   [
      'libnssdbm3.so',
      'libmozavcodec.so',
      'libmozavutil.so',
      'libipcclientcerts.so',
    ],
  }
  case application
  when 'Tor Browser'
    tor_browser_application_info(defaults)
  when 'Unsafe Browser'
    unsafe_browser_application_info(defaults)
  else
    raise "Invalid browser or XUL application: #{application}"
  end
end

When /^I open a new tab in the (.*)$/ do |browser_name|
  info = xul_application_info(browser_name)
  retry_action(2) do
    @screen.click(info[:new_tab_button_image])
    # The cursor will likely be on the newly opened tab which will
    # open a pop-up that may obscure the address bar, which would
    # cause a failure below.
    @screen.hide_cursor
    # We lower the sensitivity here because in Tor Browser 15.0, in
    # some languages (Italian and Spanish), antialiasing of the
    # address bar text we're looking for differs depending on which
    # text is displayed *before* the text we're looking for.
    @screen.wait(info[:address_bar_image], 15, sensitivity: 0.8)
  end
end

When /^I open the address "([^"]*)" in the (.* Browser)( without waiting)?$/ do |address, browser_name, non_blocking|
  browser = Dogtail::Application.new('Firefox')
  info = xul_application_info(browser_name)
  open_address = proc do
    step "I open a new tab in the #{browser_name}"
    set_browser_url(address)
    @screen.press('Return')
  end
  recovery_on_failure = proc do
    @screen.press('Escape')
    @screen.wait_vanish(info[:browser_stop_button_image], 3)
  end
  retry_method = if browser_name == 'Tor Browser'
                   method(:retry_tor)
                 else
                   proc { |p, &b| retry_action(10, recovery_proc: p, &b) }
                 end
  retry_method.call(recovery_on_failure) do
    open_address.call
    unless non_blocking
      try_for(120, delay: 3) do
        !browser.child?('Stop', roleName: 'button', retry: false) &&
          browser.child?('Reload', roleName: 'button', retry: false)
      end
    end
  end
end

def tor_browser_name
  tbb_version_json = JSON.parse(
    $vm.file_content('/usr/local/lib/tor-browser/tbb_version.json')
  )
  if tbb_version_json['channel'] == 'alpha'
    'Tor Browser Alpha'
  else
    'Tor Browser'
  end
end

def page_has_loaded_in_the_tor_browser(page_titles)
  page_titles = [page_titles] if page_titles.instance_of?(String)
  assert_equal(Array, page_titles.class)
  browser_name = tor_browser_name
  if $language == 'German'
    reload_action = 'Neu laden'
    separator = '–'
  else
    reload_action = 'Reload'
    separator = '—'
  end
  try_for(180, delay: 3) do
    # The 'Reload' button (graphically shown as a looping arrow)
    # is only shown when a page has loaded, so once we see the
    # expected title *and* this button has appeared, then we can be sure
    # that the page has fully loaded.
    @torbrowser.children(roleName: 'frame').any? do |frame|
      page_titles
        .map  { |page_title| "#{page_title} #{separator} #{browser_name}" }
        .any? { |page_title| page_title == frame.name }
    end &&
      @torbrowser.child(reload_action, roleName: 'button')
  end
end

Then /^"([^"]+)" has loaded in the Tor Browser$/ do |title|
  page_has_loaded_in_the_tor_browser(title)
end

def xul_app_shared_lib_check(pid, expected_absent_tbb_libs: [])
  absent_tbb_libs = []
  unwanted_native_libs = []
  tbb_libs = $vm.execute_successfully('ls -1 ${TBB_INSTALL}/*.so',
                                      libs: 'tor-browser').stdout.split
  firefox_pmap_info = $vm.execute("pmap --show-path #{pid}").stdout
  native_libs = $vm.execute_successfully(
    'find /usr/lib /lib -name "*.so"'
  ).stdout.split
  tbb_libs.each do |lib|
    lib_name = File.basename lib
    absent_tbb_libs << lib_name unless /\W#{lib}$/.match(firefox_pmap_info)
    native_libs.each do |native_lib|
      next unless native_lib.end_with?("/#{lib_name}")

      if /\W#{native_lib}$"/.match(firefox_pmap_info)
        unwanted_native_libs << lib_name
      end
    end
  end
  absent_tbb_libs -= expected_absent_tbb_libs
  assert(absent_tbb_libs.empty? && unwanted_native_libs.empty?,
         'The loaded shared libraries for the firefox process are not the ' \
         "way we expect them.\n" \
         "Expected TBB libs that are absent: #{absent_tbb_libs}\n" \
         "Native libs that we don't want: #{unwanted_native_libs}")
end

Then /^the (.*) uses all expected TBB shared libraries$/ do |application|
  info = xul_application_info(application)
  pid = $vm.execute_successfully(
    "pgrep --uid #{info[:user]} --full --exact '#{info[:cmd_regex]}'"
  ).stdout.chomp
  pid = pid.scan(/\d+/).first
  assert_match(/\A\d+\z/, pid, "It seems like #{application} is not running")
  xul_app_shared_lib_check(pid, expected_absent_tbb_libs: info[:unused_tbb_libs])
end

Then /^the (.*) chroot is torn down$/ do |browser|
  info = xul_application_info(browser)
  try_for(30, msg: "The #{browser} chroot '#{info[:chroot]}' was " \
                      'not removed') do
    !$vm.execute("test -d '#{info[:chroot]}'").success?
  end
end

Then /^the (.*) runs as the expected user$/ do |browser|
  info = xul_application_info(browser)
  assert_vmcommand_success(
    $vm.execute("pgrep --full --exact '#{info[:cmd_regex]}'"),
    "The #{browser} is not running"
  )
  assert_vmcommand_success(
    $vm.execute(
      "pgrep --uid #{info[:user]} --full --exact '#{info[:cmd_regex]}'"
    ),
    "The #{browser} is not running as the #{info[:user]} user"
  )
end

When /^I download some file in the Tor Browser to the (.*) directory$/ do |target_dir|
  @some_file = 'tails-signing.key'
  some_url = "https://tails.net/#{@some_file}"
  step "I open the address \"#{some_url}\" in the Tor Browser"
  # Note that the "Opening ..." dialog sometimes appear with roleName
  # "frame" and sometimes with "dialog", so we deliberately do not
  # specify the roleName.
  button = @torbrowser
           .child("Opening #{@some_file}")
           .button('Save File')
  try_for(10) { button.sensitive? }
  button.press
  desktop_portal_save_as(directory: "/home/#{LIVE_USER}/#{target_dir}")
  @torbrowser
    .button('Downloads')
    .press
  @torbrowser
    .child('Downloads', roleName: 'panel')
    .child("#{@some_file} Completed .*", roleName: 'list item')
end

Then /^the file is saved to the (.*) directory$/ do |target_dir|
  assert_not_nil(@some_file)
  try_for(10) { $vm.file_exist?("/home/#{LIVE_USER}/#{target_dir}/#{@some_file}") }
end

When /^I open the Tails homepage in the (.+)$/ do |browser|
  step "I open the address \"https://tails.net\" in the #{browser}"
end

def headings_in_page(browser, page_title)
  browser.child(page_title, roleName: 'document web').children(roleName: 'heading')
end

def page_has_heading(browser, page_title, heading)
  headings_in_page(browser, page_title).any? { |h| h.name == heading }
end

Then /^the (Tor|Unsafe) Browser shows the "([^"]+)" error$/ do |browser_name, error|
  browser = if browser_name == 'Tor'
              @torbrowser
            else
              @unsafe_browser
            end

  try_for(60, delay: 3) do
    page_has_heading(browser, 'Problem loading page', error)
  end
end

Then /^Tor Browser displays a "([^"]+)" heading on the "([^"]+)" page$/ do |heading, page_title|
  try_for(60, delay: 3) do
    page_has_heading(@torbrowser, page_title, heading)
  end
end

Then /^Tor Browser displays a '([^']+)' heading on the "([^"]+)" page$/ do |heading, page_title|
  try_for(60, delay: 3) do
    page_has_heading(@torbrowser, page_title, heading)
  end
end

Then /^I can listen to an Ogg audio track in Tor Browser$/ do
  test_url = 'https://upload.wikimedia.org/wikipedia/commons/1/1e/HTTP_cookie.ogg'
  info = xul_application_info('Tor Browser')
  open_test_url = proc do
    step "I open the address \"#{test_url}\" in the Tor Browser"
  end
  recovery_on_failure = proc do
    @screen.press('Escape')
    @screen.wait_vanish(info[:browser_stop_button_image], 3)
    open_test_url.call
  end
  try_for(20) { pipewire_input_ports.zero? }
  open_test_url.call
  retry_tor(recovery_on_failure) do
    sleep 30
    assert(pipewire_input_ports.positive?)
  end
end

Then /^I can watch a WebM video in Tor Browser$/ do
  test_url = WEBM_VIDEO_URL
  info = xul_application_info('Tor Browser')
  open_test_url = proc do
    step "I open the address \"#{test_url}\" in the Tor Browser"
  end
  recovery_on_failure = proc do
    @screen.press('Escape')
    @screen.wait_vanish(info[:browser_stop_button_image], 3)
    open_test_url.call
  end
  open_test_url.call
  retry_tor(recovery_on_failure) do
    @screen.wait('TorBrowserSampleRemoteWebMVideoFrame.png', 30)
  end
end

Then /^DuckDuckGo is the default search engine$/ do
  ddg_search_prompt = 'DuckDuckGoSearchPrompt.png'
  case $language
  when 'Arabic', 'Persian'
    ddg_search_prompt = 'DuckDuckGoSearchPromptRTL.png'
  end
  step 'I open a new tab in the Tor Browser'
  set_browser_url('a random search string')
  @screen.wait(ddg_search_prompt, 20)
end

Then(/^the screen keyboard works in Tor Browser$/) do
  osk_key_images = ['ScreenKeyboardKeyComma.png',
                    'ScreenKeyboardKeyComma_alt.png',]
  browser_bar_x = 'BrowserAddressBarComma.png'
  case $language
  when 'Arabic'
    browser_bar_x = 'BrowserAddressBarCommaRTL.png'
  when 'Persian'
    osk_key_images = ['ScreenKeyboardKeyCommaPersian.png',
                      'ScreenKeyboardKeyCommaPersian_alt.png',]
    browser_bar_x = 'BrowserAddressBarCommaRTL.png'
  end
  step 'I start the Tor Browser'
  step 'I open a new tab in the Tor Browser'
  # When opening a new tab the address bar's entry is focused which
  # should show the OSK, but it doesn't. Dogtail's .grabFocus doesn't
  # trigger it either.
  @screen.click(xul_application_info('Tor Browser')[:address_bar_image])
  @screen.wait('ScreenKeyboard.png', 20)
  @screen.wait_any(osk_key_images, 20).click
  @screen.wait(browser_bar_x, 20)
end

When /^I log-in to the Captive Portal$/ do
  step 'a web server is running on the LAN'
  captive_portal_page = "#{@web_server_url}/captive"
  step "I open the address \"#{captive_portal_page}\" in the Unsafe Browser"

  try_for(30) do
    File.exist?(@captive_portal_login_file)
  end

  step 'I close the Unsafe Browser'
end

Then /^Tor Browser's circuit view is working$/ do
  @torbrowser.child('Tor Circuit', roleName: 'button').click
  nodes = @torbrowser.child('This browser', roleName: 'list item')
                     .parent.children(roleName: 'list item')
  domain = URI.parse(get_current_browser_url).host.split('.')[-2..].join('.')
  assert_equal('This browser', nodes.first.name)
  assert_equal(domain, nodes.last.name)
  assert_equal(5, nodes.size)
end

When /^I start the Tor Browser( in offline mode)?$/ do |offline|
  launch_tor_browser(check_started: !offline)
  if offline
    zenity_dialog_click_button('Tor is not ready', 'Start Tor Browser Offline')
  end
  step 'the Tor Browser has started'
  step 'the Tor Browser loads about:tor'
end

Given /^the Tor Browser (?:has started|starts)$/ do
  try_for(60) do
    @torbrowser = Dogtail::Application.new('Firefox')
    @torbrowser.child?(roleName: 'frame', recursive: false)
  end
  browser_info = xul_application_info('Tor Browser')
  @screen.wait(browser_info[:new_tab_button_image], 20)
  try_for(120, delay: 3) do
    # We can't use Dogtail here: this step must support many languages
    # and using Dogtail would require maintaining a list of translations
    # for the "Stop" and "Reload" buttons.
    @screen.wait_vanish(browser_info[:browser_stop_button_image], 120)
    if RTL_LANGUAGES.include?($language)
      @screen.wait(browser_info[:browser_reload_button_image_rtl], 120)
    else
      @screen.wait(browser_info[:browser_reload_button_image], 120)
    end
  end
end

Given /^the Tor Browser loads about:tor$/ do
  unless File.exist?('features/images/TorBrowser2025YECBannerRTL.png')
    cmd_helper(['convert',
                '-flop',
                'features/images/TorBrowser2025YECBanner.png',
                'features/images/TorBrowser2025YECBannerRTL.png',])
  end
  @screen.wait_any(
    ['TorBrowserAboutTor.png',
     'TorBrowser2025YECBanner.png',
     'TorBrowser2025YECBannerRTL.png',], 60
  )
end

# Try to debug tails#20297 ("The proxy server is refusing connections"
# after Tor has bootstrapped).
# rubocop:disable Metrics/MethodLength
# rubocop:disable Metrics/AbcSize
def debug_issue20297
  debug_log('Issue #20297: we hit it!')
  debug_log($vm.execute('ss -tlpn').stdout)
  debug_log("Jenkins node name: #{cmd_helper('hostname -A')}")
  debug_log("System DNS resolver: #{Resolv::DNS::Config.default_config_hash}")
  debug_log('DNS resolution (Ruby Resolv) of tails.net: ' \
            "#{Resolv.getaddresses('tails.net')}")
  debug_log('DNS resolution (host command) of tails.net: ' \
            "#{cmd_helper('host -t a tails.net')}")
  debug_log("DNS resolution of tails.net inside Tails: #{$vm.execute(
    'host -t a tails.net', user: LIVE_USER
  ).stdout}")
  debug_log("Issue #20297: checking if Tor Browser's SocksPort is working")
  begin
    c = nil
    Timeout.timeout(5) do
      c = $vm.execute(
        '/usr/bin/printf "\x05\x01\x00\r\n" | nc -v 10.200.1.1 9050', user: LIVE_USER
      )
    end
  rescue Timeout::Error
    debug_log("Issue #20297: SocksPort didn't respond within 5 seconds")
  else
    debug_log("Issue #20297: netcat said: #{c.stderr}")
    if c.stdout == "\x05\x00"
      debug_log('Issue #20297: SocksPort seems to be working')
    else
      debug_log('Issue #20297: SocksPort responded with something unexpected: ' \
                "#{c.stdout.bytes.pack('c*').inspect}")
    end
  end
  begin
    debug_log('Issue #20297: trying to open https://tails.net/ in the Tor Browser ' \
              'after restarting Tor')
    $vm.execute_successfully('systemctl stop tor@default.service')
    try_for(30) do
      $vm.execute(
        '/bin/systemctl --quiet is-active tails-tor-has-bootstrapped.target'
      ).failure?
    end
    $vm.execute_successfully('systemctl start tor@default.service')
    wait_until_tor_is_working
  rescue StandardError
    debug_log('Issue #20297: failed to restart Tor, not retrying to reopen in ' \
              'Tor Browser')
  else
    begin
      step 'I open the address "https://tails.net/" in the Tor Browser'
      page_has_loaded_in_the_tor_browser(['Tails'])
      debug_log('Issue #20297: restarting Tor WORKS!')
    rescue StandardError
      debug_log('Issue #20297: restarting Tor did not help')
    ensure
      @screen.press('ctrl', 'w')
    end
  end
rescue StandardError
  # Ignore all uncaught exceptions, we did our best
end
# rubocop:enable Metrics/AbcSize
# rubocop:enable Metrics/MethodLength

Given /^the Tor Browser loads the (Tails homepage|Tails GitLab)$/ do |page|
  case page
  when 'Tails homepage'
    titles = ['Tails']
  when 'Tails GitLab'
    titles = ['tails · GitLab']
  else
    raise "Unsupported page: #{page}"
  end
  begin
    page_has_loaded_in_the_tor_browser(titles)
  rescue RuntimeError => e
    if @torbrowser.child?('The proxy server is refusing connections',
                          roleName: 'heading', retry: false)
      debug_issue20297
    end
    raise e
  end
end

Given /^I add a bookmark to eff.org in the Tor Browser$/ do
  url = 'https://www.eff.org'
  step "I open the address \"#{url}\" in the Tor Browser"
  step 'the Tor Browser shows the ' \
       '"The proxy server is refusing connections" error'
  @torbrowser.child('Bookmark this page (Ctrl+D)', roleName: 'button').click
  prompt = @torbrowser.child('Add bookmark', roleName: 'panel')
  prompt.child('Location', roleName: 'combo box').open
  prompt.child('Bookmarks Menu', roleName: 'menu item').click
  prompt.button('Save').press
end

Given /^the Tor Browser has a bookmark to eff.org$/ do
  @screen.press('alt', 'b')
  @screen.wait('TorBrowserEFFBookmark.png', 10)
end

When /^I can print the current page as "([^"]+[.]pdf)" to the (.*) directory$/ do |output_file, target_dir|
  output_dir = "/home/#{LIVE_USER}/#{target_dir}"
  @screen.press('ctrl', 'p')
  @torbrowser.child('Save', roleName: 'button').press
  desktop_portal_save_as(filename: output_file, directory: output_dir)
  try_for(30,
          msg: "The page was not printed to #{output_dir}/#{output_file}") do
    $vm.file_exist?("#{output_dir}/#{output_file}")
  end
end

When /^I (can|cannot) save the current page as "([^"]+[.]html)" to the (.*) (directory|GNOME bookmark)$/ do |should_work, output_file, target_dir, bookmark|
  should_work = should_work == 'can'
  output_dir = "/home/#{LIVE_USER}/#{target_dir}"
  browser_save_page_as(filename: output_file, directory: output_dir,
                       bookmark: bookmark == 'GNOME bookmark')
  if should_work
    try_for(20,
            msg: "The page was not saved to #{output_dir}/#{output_file}") do
      $vm.file_exist?("#{output_dir}/#{output_file}")
    end
  else
    @screen.wait('TorBrowserCannotSavePage.png', 10)
  end
end

When /^I request a new identity in Tor Browser$/ do
  @torbrowser.child(tor_browser_name, roleName: 'button').press
  @torbrowser.child('New identity', roleName: 'button').press
  @torbrowser.child("Restart #{tor_browser_name}", roleName: 'button').press
end

Then /^the Tor Browser has (\d+) tabs? open$/ do |expected_tab_count|
  tabs = @torbrowser.child('Browser tabs', roleName: 'tool bar')
                    .child(roleName: 'page tab list')
                    .children(roleName: 'page tab', showingOnly: false)
  assert_equal(expected_tab_count.to_i, tabs.size)
end
