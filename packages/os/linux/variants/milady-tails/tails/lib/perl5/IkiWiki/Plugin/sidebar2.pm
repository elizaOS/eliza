#!/usr/bin/perl
package IkiWiki::Plugin::sidebar2;

=head1 NAME

IkiWiki::Plugin::sidebar2 - Improved version of IkiWiki::Plugin::sidebar

=head1 VERSION

This describes version B<0.1> of IkiWiki::Plugin::sidebar2

=cut

our $VERSION = '0.1';

=head1 DESCRIPTION

Improved version of IkiWiki::Plugin::sidebar2. Main features are:

- allowing several sidebars;
- enabling sidebars using pagespects.

See doc/plugins/sidebar2.mdwn for documentation.

=head1 PREREQUISITES

IkiWiki

=head1 URL

http://atelier.gresille.org/projects/gresille-ikiwiki/wiki/Sidebar2
http://ikiwiki.info/plugins/contrib/sidebar2/

=head1 AUTHOR

Tuomo Valkonen wrote the original Ikiwiki::plugin::sidebar.
Others (on http://ikiwiki.info) helped to improve it.
Louis Paternault (spalax) <spalax at gresille dot org> improved it to write Ikiwiki::plugin::sidebar2.

=head1 COPYRIGHT

Copyright 2006 Tuomo Valkonen <tuomov at iki dot fi>
Copyright 2013 by Louis Paternault <spalax at gresille dot org>

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA

=cut

use warnings;
use strict;
use IkiWiki 3.00;

sub import {
	hook(type => "checkconfig", id => "sidebar2", call => \&checkconfig);
	hook(type => "getsetup", id => "sidebar2", call => \&getsetup);
	hook(type => "preprocess", id => "sidebar", call => \&preprocess);
	hook(type => "pagetemplate", id => "sidebar2", call => \&pagetemplate);
}

sub checkconfig () {
	# Parsing "sidebars"
	my %sidebars;
	if (defined $config{global_sidebars} and (ref($config{global_sidebars}) eq "ARRAY")) {
		my $length = $#{$config{global_sidebars}}+1;
		if (($length % 3) != 0) {
			error("'sidebars' length must be a multiple of 3.");
		}
		for(my $i=0; $i<$length/3;$i += 1) {
			unless(exists($sidebars{$config{global_sidebars}[3*$i]})) {
				$sidebars{$config{global_sidebars}[3*$i]} = ();
			}
			push(
				@{$sidebars{$config{global_sidebars}[3*$i]}},
				@{[[
					$config{global_sidebars}[3*$i+1],
					$config{global_sidebars}[3*$i+2],
				]]}
			);
		}
	} else {
		if (not defined $config{global_sidebars}) {
			 $config{global_sidebars} = 1;
		}
		if (IkiWiki::yesno($config{global_sidebars})) {
			%sidebars = (
				"sidebar" => [["sidebar", "*"]]
			);
		}
	}

	@{$config{sidebars}} = %sidebars;
}

sub getsetup () {
	return
		plugin => {
			safe => 1,
			rebuild => 1,
		},
		global_sidebars => {
			type => "boolean",
			example => 1,
			description => "show sidebar page on all pages?",
			safe => 1,
			rebuild => 1,
		},
}

my %pagesidebar;

sub preprocess (@) {
	my %params=@_;

	my $page=$params{page};
	return "" unless $page eq $params{destpage};
	
	if (! defined $params{var}) {
		$params{var} = "sidebar";
	}
	if (! defined $params{content}) {
		$pagesidebar{$page}{$params{var}}=undef;
	}
	else {
		my $file = $pagesources{$page};
		my $type = pagetype($file);

		unless(exists($pagesidebar{$page})) {
			$pagesidebar{$page} = ();
		}
		$pagesidebar{$page}{$params{var}} = IkiWiki::htmlize($page, $page, $type,
			IkiWiki::linkify($page, $page,
				IkiWiki::preprocess($page, $page, $params{content})));
	}

	return "";
}

my $oldfile;
my $oldcontent;

sub sidebar_content ($$$$) {
	my $templatevar=shift;
	my $page=shift;
	my $included=shift;
	my $pagespec=shift;
	
	return delete $pagesidebar{$page}{$templatevar} if defined $pagesidebar{$page}{$templatevar};

	return if ! exists $pagesidebar{$page}{$templatevar} && 
			! pagespec_match($page, $pagespec)
		;

	my $sidebar_page=bestlink($page, $included) || return;
	my $sidebar_file=$pagesources{$sidebar_page} || return;
	my $sidebar_type=pagetype($sidebar_file);
	
	if (defined $sidebar_type) {
		# FIXME: This isn't quite right; it won't take into account
		# adding a new sidebar page. So adding such a page
		# currently requires a wiki rebuild.
		add_depends($page, $sidebar_page);

		my $content;
		if (defined $oldfile && $sidebar_file eq $oldfile) {
			$content=$oldcontent;
		}
		else {
			$content=readfile(srcfile($sidebar_file));
			$oldcontent=$content;
			$oldfile=$sidebar_file;
		}

		return unless length $content;
		return IkiWiki::htmlize($sidebar_page, $page, $sidebar_type,
					 IkiWiki::linkify($sidebar_page, $page,
					 IkiWiki::preprocess($sidebar_page, $page,
					 IkiWiki::filter($sidebar_page, $page, $content))));
	}

}

sub pagetemplate (@) {
	my %params=@_;

	my $template=$params{template};
	my %sidebars = @{$config{sidebars}};
	if ($params{destpage} eq $params{page}) {
		foreach my $templatevar (keys(%sidebars)) {
			if ($template->query(name => $templatevar) and exists($sidebars{$templatevar})) {
				for my $data (@{$sidebars{$templatevar}}) {
					my $content=sidebar_content($templatevar, $params{destpage}, @{$data}[0], @{$data}[1]);
					if (defined $content && length $content) {
						$template->param($templatevar => $content);
						last;
					}
				}
			}
		}
	}
}

1
