[[!meta title="Joshua, September 2025"]]

**Tell us a bit about who you are what you do.**

I'm an IT specialist at a power company in the US. I use Tails both at work and
at home.

At home for privacy reasons. I use *Ricochet Refresh*, *Tor Browser*,
*OnionShare*. Everyone thinks that you use these tools because you have
something to hide, but it's not my case. I use these tools because I value my
privacy.

For work, Tails is very useful, for example, if there is a suspicious link that
I want to investigate. Firefox is sandboxed in general, but the sandbox in
Tails is better tested. If something happens to the Tails instance, you just
restart it and it's fresh again.

Doing things in general that you are unsure of, for example, a bash script that
I found on GitHub, I run it in Tails and see what happens. Tails doesn't have
access to the local network, so I don't need to work about lateral movements.
It's like a condom for the network.

Tails is also just a nice bootable operating system. This morning, I needed to
clone a drive to another drive. This was an NTFS drive, so I tried on Windows
and Windows Explorer just crashed. I'm going to boot up Tails because it
supports NTFS.

I use Tails for any generic GNU/Linux need. I run Arch or Trisquel on my
computers. If I need to use GNU on a computer that don't have it, I'll just use
Tails. Some weeks I don't use it at all. Some weeks I use it every day. I keep
a Tails USB stick on my car keys. That's how much I use it!

Tails is really performant. I feel that GNOME is slow, but Tails is pretty
fast. GNOME isn't slow on Debian either. Maybe it's an Ubuntu thing. Canonical
is an evil company.

**How is Tails being used around you?**

I only know personally one other tech-savvy friend who uses Tails. In the
University, people sometimes used Tails to get passed the network filters.

**What are the other tasks that you perform most often when using Tails?**

At home I use it almost every day. I have a laptop with a Tails USB stick in it
and Tails is the first boot device.

I use mainly *Tor Browser*. I have *Tor Browser* on my Arch machines, but I
don't trust the fact that the system isn't amnesiac. If I'm going on Tor, I
want the system to wipe itself.

If I'm going to the coffeeshop and connecting to the Wi-Fi, I'm going to use
Tails. I use Tails for things that have zero anonymity like log in and check my
emails, if I'm in public.

I don't trust VPN providers. I trust Proton but not that much. I don't trust
anybody. The Tor network does so much good. And Tails in particular does so
much good. I don't really know what I would do without it...

I don't trust *Whonix* either because it still runs on the host machine. If you
break out of the VM, the routing is done by the other VM. But, the attack
vector is probably going to be the host. I like that Tails runs on bare metal.

**What other tools or features do you find the most valuable?**

*Metadata Cleaner*. Even if I'm sending something to my family, I'm running it
through Metadata Cleaner. I went on a date recently. She sent me a picture of
her dog and the location metadata is in there. Metadata is horrifically
dangerous.

I do not use persistence at all. I don't trust it. Isn't that weird? If I want
to save a file, I would use another LUKS USB stick.

**That means you don't store any configuration of your Tails?**

I reconnect it to the network every time. I set dark mode every time.

I use special bridges a lot, even when I don't have too, an obfs4 and a
WebTunnel bridge. These bridges are just used by a couple of people. I made QR
codes for my bridges on laminated paper and I scan them every time.

On some computers, Tails doesn't detect the webcam, even when other GNU/Linux
systems do. Then, I type in the whole thing. The WebTunnel bridges aren't that
bad.

WebTunnel is kind of a hack, but I'm surprised how well it works. I'm getting
at least 10 Mbps, something 50-60 Mbps over Tor. The network has gotten better so
much faster in the last few years.

These 2 bridges are on the same hardware and the same network, and I feel that
WebTunnel is faster and has less latency.

**Why is using bridges is important to you?**

Because I know for sure that my guard node is not poisoned. With default
bridges, I wouldn't have this guarantee.

**Have you encountered any challenges or limitations when using Tails?**

If I choose to *Hide* in *Tor Connection* and it fails to connect to my bridges
for some reason, I cannot go back and choose using regular relays. I guess
that's because you don't want people who actually need to hide the fact that
they are using Tor to change it after the fact. You're sacrifizing 30 seconds
of me having to restart it to avoid people getting caught by repressive
governments, so I get it.

I have some minor bug reports about Tails 7.0~rc2. I'll just start Tails...

It boots with the screen brightness very far down, at 1 tick away from the
lowest. Whereas 6.19 boots with the brightness all up.

I have so many Tails USB sticks they are everywhere. Then, an update comes out
and it's time to update all of them...

If I boot on a newer version and want to clone to an older version with Tails
Cloner, sometimes it tells me that I cannot do that. Might be an isolated case.

Turning on Night Light doesn't do anything in 7.0~rc2.

**Try going to Settings&nbsp;▸ Display&nbsp;▸ Night Light.** 

Oh, from 20:00 to 06:00. It's on a timer. In the old Tails it would just turn
on.

When I went to scan a QR code I had an error at the bottom. It wasn't actually
an error, it was just kind of there.

**Which improvements or new features would you like to see in Tails?**

I could say "*you should put Ricochet on it*", but who is using that? It should
be generally applicable to warrant being in the ISO.

Do not remove *Brasero*. Burning a CD on Windows is horrible. I have actually
booted into Tails for the sole purpose of burning a CD.

I really like the *GNOME Disk Utility*.

Is *GnuPG Log Viewer* new? It spits out an error.

I really like the automatic updater. I never had the automatic updater not
work. I do online updates for all my USB sticks. It only takes 5-10 minutes.
I'm putting so much strain on the Tor network...

Sometimes I go into *View Tor Circuits* just to look at my circuits. I'm very
methodical. Right after *Tor Connection*, I can see it making connections out.
One of them is to Fedora, then another IP address starting with 185. Maybe a
wiki page about what Tails does when booting...

The verification works very well. I'm sure you guys have reasons behind
everything you do, but I would like to have the MD5 sum on the page. I see
there is the OpenPGP signature.

I'm setting off alerts at my work because I connected to Tor. Pretty funny.

I use Tails for everything. It's fantastic. I don't want lots of change because
I don't think there needs to be much change.

Every time I connect, I always hit the Tor Check button. My understanding is
that, unless it's going through the Tor proxy, nothing can get out. I use it
anyways, because then I then I know for sure that it's working.

The page in *Tor Browser* that says "*Your connection is not managed by Tor
Browser*". That didn't used to be there. When I saw it for the first time, I
wondered what happened. That's kind of alarming.

I swear there used to be a security slider to change the security level. Now it
kind of buried and it requires a reboot of the browser.

I like that *uBlock Origin* is there.

I have a Core i5 Bridge dual core CPU with hyperthreading in a very old
Panasonic Toughbook. In Puppy, all 4 CPUs come up. On Tails, the hyperthreads
don't turn on and Tails is remarkably slow. I'm just curious why.

I use the emergency shutoff all the time because I'm lazy. I know with
Persistent Storage you're not supposed to do that.
