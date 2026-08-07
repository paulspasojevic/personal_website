#!/usr/bin/env python3
"""
Build a LaTeX résumé from the shared JSON data files.

Uses the Pavlic CV template style — section titles as marginal notes,
Times font, and the outerlist/innerlist environments.

Usage:
    python resume/build.py          # generate resume.tex and compile to PDF
    python resume/build.py --tex    # generate resume.tex only (no compilation)

The script reads from data/{profile,jobs,education,projects}.json — the same
files the website uses — and writes resume/resume.tex (and resume/resume.pdf
when a TeX engine is available).
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_DIR = Path(__file__).resolve().parent
TEX_FILE = OUT_DIR / "resume.tex"


# ---------------------------------------------------------------------------
# LaTeX helpers
# ---------------------------------------------------------------------------

_LATEX_SPECIAL = re.compile(r"([&%$#_{}~^\\])")

_LATEX_REPLACEMENTS = {
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "\\": r"\textbackslash{}",
}


def tex_escape(text: str) -> str:
    """Escape characters that are special in LaTeX."""
    # Replace en-dash (U+2014) with LaTeX em-dash so it renders properly
    text = text.replace("—", "---")
    text = text.replace("–", "--")
    return _LATEX_SPECIAL.sub(lambda m: _LATEX_REPLACEMENTS[m.group(1)], text)


def tex_href(url: str, text: str) -> str:
    """Wrap *text* in a clickable hyperref pointing at *url*."""
    return rf"\href{{{url}}}{{{tex_escape(text)}}}"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load(name: str) -> list | dict:
    with open(DATA / name) as f:
        return json.load(f)


def visible(entries: list[dict]) -> list[dict]:
    """Filter out entries with ``"visible": false``."""
    return [e for e in entries if e.get("visible", True)]


# ---------------------------------------------------------------------------
# Section renderers — each returns a string of LaTeX body content
# ---------------------------------------------------------------------------

def render_education(entries: list[dict]) -> str:
    lines = [r"\section{Education}"]
    for i, e in enumerate(entries):
        dates = e["start"] if e["start"] == e["end"] else f'{e["start"]}--{e["end"]}'
        lines.append("")
        lines.append(rf"\textbf{{{tex_escape(e['degree'])}}},")
        lines.append(rf"        {tex_escape(e['institution'])}")
        lines.append(rf"        \hfill {{{tex_escape(dates)}}}")
        if e.get("note"):
            lines.append(r"\begin{innerlist}")
            lines.append(rf"    \item[] {tex_escape(e['note'])}")
            lines.append(r"\end{innerlist}")
        if i < len(entries) - 1:
            lines.append("")
            lines.append(r"\halfblankline")
    return "\n".join(lines)


def render_experience(entries: list[dict]) -> str:
    lines = [r"\section{Experience}"]
    for i, e in enumerate(entries):
        dates = f'{e["start"]}--{e["end"]}'
        lines.append("")
        lines.append(rf"\textbf{{{tex_escape(e['role'])}}},")
        lines.append(rf"        {tex_escape(e['company'])}")
        lines.append(rf"        \hfill {{{tex_escape(dates)}}}")
        if e.get("note"):
            lines.append(r"\begin{innerlist}")
            lines.append(rf"    \item[] {tex_escape(e['note'])}")
            lines.append(r"\end{innerlist}")
        if i < len(entries) - 1:
            lines.append("")
            lines.append(r"\halfblankline")
    return "\n".join(lines)


def render_projects(entries: list[dict]) -> str:
    lines = [r"\section{Projects}"]
    for i, e in enumerate(entries):
        title = tex_href(e["url"], e["name"]) if e.get("url") else tex_escape(e["name"])
        tags = ", ".join(e.get("tags", []))
        lines.append("")
        lines.append(rf"\textbf{{{title}}}")
        lines.append(rf"        \hfill {{{tex_escape(e['year'])}}}")
        if e.get("note") or tags:
            lines.append(r"\begin{innerlist}")
            if tags:
                lines.append(rf"    \item[] \textit{{{tex_escape(tags)}}}")
            if e.get("note"):
                lines.append(rf"    \item[] {tex_escape(e['note'])}")
            lines.append(r"\end{innerlist}")
        if i < len(entries) - 1:
            lines.append("")
            lines.append(r"\halfblankline")
    return "\n".join(lines)


def render_publications(entries: list[dict]) -> str:
    lines = [r"\section{Publications}", "", r"\begin{bibsection}"]
    for e in entries:
        # Format: Authors. "Title." *Journal*, vol(issue), pages, year.
        authors = ", ".join(tex_escape(a) for a in e["authors"])
        title = tex_escape(e["title"])
        journal = tex_escape(e["journal"])

        # Build the volume/issue/pages string
        cite_parts = []
        vol = e.get("volume", "")
        issue = e.get("issue", "")
        if vol and issue:
            cite_parts.append(f"{tex_escape(vol)}({tex_escape(issue)})")
        elif vol:
            cite_parts.append(tex_escape(vol))
        if e.get("pages"):
            cite_parts.append(tex_escape(e["pages"]))
        cite_tail = ", ".join(cite_parts)

        year = tex_escape(e["year"])

        # Link the title via DOI if available
        if e.get("doi"):
            title_str = rf"\href{{https://doi.org/{e['doi']}}}{{{title}}}"
        else:
            title_str = title

        entry = rf"    \item {authors}. ``{title_str}.'' \textit{{{journal}}}, {cite_tail}, {year}."
        lines.append(entry)
    lines.append(r"\end{bibsection}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Preamble — adapted from the Pavlic CV template
# ---------------------------------------------------------------------------

PREAMBLE = r"""\documentclass[10pt]{article}
\RequirePackage[T1]{fontenc}

\usepackage{times}
\usepackage{calc}
\usepackage[shortcuts]{extdash}

% Section titles as marginal notes
\reversemarginpar

% A4 paper layout
\usepackage[paper=a4paper,
            marginparwidth=30.5mm,
            marginparsep=1.5mm,
            margin=25mm,
            includemp]{geometry}

\setlength{\parindent}{0in}

% List environments
\usepackage[shortlabels]{enumitem}

% Bibliography-style lists
\makeatletter
\newlength{\bibhang}
\setlength{\bibhang}{1em}
\newlength{\bibsep}
 {\@listi \global\bibsep\itemsep \global\advance\bibsep by\parsep}
\newlist{bibsection}{itemize}{3}
\setlist[bibsection]{label=,leftmargin=\bibhang,%
        itemindent=-\bibhang,
        itemsep=\bibsep,parsep=\z@,partopsep=0pt,
        topsep=0pt}
\newlist{bibenum}{enumerate}{3}
\setlist[bibenum]{label=[\arabic*],resume,leftmargin={\bibhang+\widthof{[999]}},%
        itemindent=-\bibhang,
        itemsep=\bibsep,parsep=\z@,partopsep=0pt,
        topsep=0pt}
\let\oldendbibenum\endbibenum
\def\endbibenum{\oldendbibenum\vspace{-.6\baselineskip}}
\let\oldendbibsection\endbibsection
\def\endbibsection{\oldendbibsection\vspace{-.6\baselineskip}}
\makeatother

% Page numbers: "N of M"
\usepackage{fancyhdr,lastpage}
\pagestyle{fancy}
\fancyhf{}\renewcommand{\headrulewidth}{0pt}
\fancyfootoffset{\marginparsep+\marginparwidth}
\newlength{\footpageshift}
\setlength{\footpageshift}
          {0.5\textwidth+0.5\marginparsep+0.5\marginparwidth-2in}
\lfoot{\hspace{\footpageshift}%
       \parbox{4in}{\, \hfill %
                    \arabic{page} of \protect\pageref*{LastPage} %
                    \hfill \,}}

% Hyperlinks
\usepackage{color,hyperref}
\definecolor{darkblue}{rgb}{0.0,0.0,0.3}
\hypersetup{colorlinks,breaklinks,
            linkcolor=darkblue,urlcolor=darkblue,
            anchorcolor=darkblue,citecolor=darkblue}

%%% Heading
\newcommand{\makeheading}[2][]%
        {\hspace*{-\marginparsep minus \marginparwidth}%
         \begin{minipage}[t]{\textwidth+\marginparwidth+\marginparsep}%
             {\large \bfseries #2 \hfill #1}\\[-0.15\baselineskip]%
                 \rule{\columnwidth}{1pt}%
         \end{minipage}}

%%% Section headings — small caps in the margin
\renewcommand{\section}[1]{\pagebreak[3]%
    \vspace{1.3\baselineskip}%
    \phantomsection\addcontentsline{toc}{section}{#1}%
    \noindent\llap{\scshape\smash{\parbox[t]{\marginparwidth}{\hyphenpenalty=10000\raggedright #1}}}%
    \vspace{-\baselineskip}\par}

%%% List helpers
\newcommand*\fixendlist[1]{%
    \expandafter\let\csname preFixEndListend#1\expandafter\endcsname\csname end#1\endcsname
    \expandafter\def\csname end#1\endcsname{\csname preFixEndListend#1\endcsname\vspace{-0.6\baselineskip}}}
\let\originalItem\item
\newcommand*\fixouterlist[1]{%
    \expandafter\let\csname preFixOuterList#1\expandafter\endcsname\csname #1\endcsname
    \expandafter\def\csname #1\endcsname{\let\oldItem\item\def\item{\pagebreak[2]\oldItem}\csname preFixOuterList#1\endcsname}
    \expandafter\let\csname preFixOuterListend#1\expandafter\endcsname\csname end#1\endcsname
    \expandafter\def\csname end#1\endcsname{\let\item\oldItem\csname preFixOuterListend#1\endcsname}}
\newcommand*\fixinnerlist[1]{%
    \expandafter\let\csname preFixInnerList#1\expandafter\endcsname\csname #1\endcsname
    \expandafter\def\csname #1\endcsname{\let\oldItem\item\let\item\originalItem\csname preFixInnerList#1\endcsname}
    \expandafter\let\csname preFixInnerListend#1\expandafter\endcsname\csname end#1\endcsname
    \expandafter\def\csname end#1\endcsname{\csname preFixInnerListend#1\endcsname\let\item\oldItem}}

\newlist{outerlist}{itemize}{3}
    \setlist[outerlist]{label=\enskip\textbullet,leftmargin=*}
    \fixendlist{outerlist}
    \fixouterlist{outerlist}

\newlist{lonelist}{itemize}{3}
    \setlist[lonelist]{label=\enskip\textbullet,leftmargin=*,partopsep=0pt,topsep=0pt}
    \fixendlist{lonelist}
    \fixouterlist{lonelist}

\newlist{innerlist}{itemize}{3}
    \setlist[innerlist]{label=\enskip\textbullet,leftmargin=*,parsep=0pt,itemsep=0pt,topsep=0pt,partopsep=0pt}
    \fixinnerlist{innerlist}

\newlist{loneinnerlist}{itemize}{3}
    \setlist[loneinnerlist]{label=\enskip\textbullet,leftmargin=*,parsep=0pt,itemsep=0pt,topsep=0pt,partopsep=0pt}
    \fixendlist{loneinnerlist}
    \fixinnerlist{loneinnerlist}

\newcommand{\blankline}{\quad\pagebreak[3]}
\newcommand{\halfblankline}{\quad\vspace{-0.5\baselineskip}\pagebreak[3]}

% Email helper
\providecommand*\emaillink[1]{\nolinkurl{#1}}
\providecommand*\email[1]{\href{mailto:#1}{\emaillink{#1}}}

\usepackage{url}
\urlstyle{same}
"""


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------

def build_contact(profile: dict) -> str:
    """Build the contact-information section in the Pavlic table layout."""
    # Left column: email + phone
    # Right column: GitHub
    left_items = []
    if profile.get("email"):
        left_items.append(rf"\textit{{E-mail:}} \email{{{profile['email']}}}")
    if profile.get("phone"):
        left_items.append(rf"\textit{{Phone:}} {tex_escape(profile['phone'])}")

    right_items = []
    if profile.get("github"):
        display = re.sub(r"https?://", "", profile["github"])
        right_items.append(rf"\textit{{GitHub:}} \href{{{profile['github']}}}{{{tex_escape(display)}}}")

    left_col = r" \\" "\n".join(left_items)
    right_col = r" \\" "\n".join(right_items)

    lines = [
        r"\section{Contact}",
        "",
        r"\newlength{\rcollength}\setlength{\rcollength}{2.1in}%",
        r"\begin{tabular}[t]{@{}p{\textwidth-\rcollength}@{}p{\rcollength}}%",
        r"\parbox{\textwidth-\rcollength}{%",
    ]
    lines.append(r" \\".join(left_items) + "}")
    lines.append("&")
    lines.append(r"\parbox{\rcollength}{%")
    lines.append(r" \\".join(right_items) + "}")
    lines.append(r"\end{tabular}")
    return "\n".join(lines)


def build_document(profile: dict, sections: str) -> str:
    """Return the full .tex source."""
    header = rf"""
\begin{{document}}
\makeheading{{{tex_escape(profile['name'])}}}

"""
    contact = build_contact(profile)
    return PREAMBLE + header + contact + "\n\n" + sections + "\n\n" + r"\end{document}" + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    tex_only = "--tex" in sys.argv

    # Load data
    profile = load("profile.json")
    education = visible(load("education.json"))
    experience = visible(load("jobs.json"))
    projects = visible(load("projects.json"))
    publications = visible(load("publications.json"))

    # Render sections
    sections = "\n\n".join([
        render_education(education),
        render_experience(experience),
        render_publications(publications),
        render_projects(projects),
    ])

    # Write .tex
    tex_source = build_document(profile, sections)
    TEX_FILE.write_text(tex_source)
    print(f"wrote {TEX_FILE}")

    if tex_only:
        return

    # Compile to PDF — run twice for page references ("1 of N")
    engine = shutil.which("pdflatex") or shutil.which("lualatex") or shutil.which("xelatex")
    if not engine:
        print("no TeX engine found — install TeX Live or pass --tex to skip compilation")
        sys.exit(1)

    for pass_num in (1, 2):
        result = subprocess.run(
            [engine, "-interaction=nonstopmode", "-halt-on-error", TEX_FILE.name],
            cwd=OUT_DIR,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(result.stdout[-2000:] if len(result.stdout) > 2000 else result.stdout)
            print("compilation failed", file=sys.stderr)
            sys.exit(1)

    pdf = TEX_FILE.with_suffix(".pdf")
    print(f"wrote {pdf}")


if __name__ == "__main__":
    main()
