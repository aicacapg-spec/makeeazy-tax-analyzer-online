// lib/analyzer.js — Deep ITR JSON parser + report builder

function analyzeITR(itrResults, tisData, profile) {
  const successful = itrResults.filter(r => r.success);

  const yearlyData = successful.map(r => {
    const parsed = deepParseITR(r.jsonData, r.itrType, r.ay);
    return { ...parsed, ay: r.ay, itrType: r.itrType || parsed.detectedType, ackNum: r.ackNum };
  });

  if (!profile.name && yearlyData.length > 0 && yearlyData[0].name) profile.name = yearlyData[0].name;
  if (!profile.dob && yearlyData.length > 0 && yearlyData[0].dob) profile.dob = yearlyData[0].dob;

  const itrTypes = {};
  yearlyData.forEach(y => { itrTypes[y.itrType] = (itrTypes[y.itrType] || 0) + 1; });

  // Clean TIS data - remove null values
  const cleanTIS = {};
  for (const [fy, data] of Object.entries(tisData || {})) {
    const cats = data?.categories || {};
    const cleaned = {};
    for (const [k, v] of Object.entries(cats)) {
      if (v && (v.processed || v.reported)) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length > 0) cleanTIS[fy] = { categories: cleaned };
  }

  // Cross verification
  const crossVerification = yearlyData.map(y => {
    const startYear = parseInt((y.ay || '').split('-')[0]) - 1;
    const fy = `${startYear}-${(startYear + 1).toString().slice(-2)}`;
    const tis = cleanTIS[fy];
    const mismatches = [];
    if (tis && tis.categories) {
      const cats = tis.categories;
      if (cats.salary && y.income.salary) {
        const tisVal = cats.salary.processed || 0;
        if (Math.abs(tisVal - y.income.salary) > 1000)
          mismatches.push({ field: 'Salary', itr: y.income.salary, tis: tisVal });
      }
      if (cats.interest && y.income.otherSources) {
        const tisVal = cats.interest.processed || 0;
        if (tisVal > 0 && y.income.otherSources === 0)
          mismatches.push({ field: 'Interest', itr: y.income.otherSources, tis: tisVal });
      }
    }
    return { ay: y.ay, fy, hasTIS: !!tis, mismatches };
  });

  return {
    meta: { pan: profile.pan, name: profile.name, dob: profile.dob, generatedAt: new Date().toISOString(), version: '3.1' },
    summary: {
      totalReturns: itrResults.length,
      downloaded: successful.length,
      failed: itrResults.length - successful.length,
      itrTypesUsed: itrTypes,
      tisYears: Object.keys(cleanTIS).length,
      latestAY: yearlyData[0]?.ay || '-',
      latestRegime: yearlyData[0]?.regime || '-',
      latestIncome: yearlyData[0]?.totalIncome || 0,
      latestTax: yearlyData[0]?.tax?.totalLiability || 0
    },
    yearlyITR: yearlyData,
    tisData: cleanTIS,
    crossVerification,
    failedReturns: itrResults.filter(r => !r.success).map(r => ({ ay: r.ay, error: r.error }))
  };
}

function deepParseITR(json, itrType, ay) {
  const r = {
    name: '', dob: '', email: '', mobile: '', address: '',
    regime: '-', filingType: '', detectedType: '',
    income: { salary: 0, houseProperty: 0, businessProfession: 0, capitalGains: { stcg: 0, ltcg: 0, total: 0 }, otherSources: 0, otherSourcesBreakdown: [], exemptIncome: 0, agriculturalIncome: 0 },
    grossTotal: 0,
    deductions: { total: 0, sec80C: 0, sec80D: 0, sec80G: 0, sec80TTA: 0, sec80CCD: 0, details: {} },
    totalIncome: 0,
    tax: { onIncome: 0, rebate87A: 0, surcharge: 0, cess: 0, totalLiability: 0, netLiability: 0, tds: 0, tcs: 0, advanceTax: 0, selfAssessment: 0, totalPaid: 0, refund: 0, payable: 0, interest234A: 0, interest234B: 0, interest234C: 0, lateFee: 0, totalWithInterest: 0 },
    schedules: {}
  };

  if (!json || !json.ITR) return r;
  const itrKey = Object.keys(json.ITR)[0];
  const d = json.ITR[itrKey];
  if (!d) return r;
  r.detectedType = itrKey;

  // ===== Personal Info =====
  try {
    const pi = d.PartA_GEN1?.PersonalInfo || d.PersonalInfo || d.PartA_GEN?.PersonalInfo || {};
    const an = pi.AssesseeName || pi;
    r.name = [an.FirstName, an.MiddleName, an.SurNameOrOrgName].filter(Boolean).join(' ');
    // Company/Org PAN — name is in OrgFirmInfo
    if (!r.name || r.name.trim() === '') {
      const org = d.PartA_GEN1?.OrgFirmInfo || d.PartA_GEN2For6?.OrgFirmInfo || {};
      r.name = org.AssesseeName?.SurNameOrOrgName || org.NameOfAssessee || '';
    }
    r.dob = pi.DOB || an.DOB || d.PartA_GEN1?.OrgFirmInfo?.DateOfIncor || '';
    const addr = pi.Address || d.PartA_GEN1?.OrgFirmInfo?.Address || {};
    r.email = addr.EmailAddress || pi.EmailAddress || '';
    r.mobile = addr.MobileNo || pi.MobileNo || '';
  } catch(e) {}

  // ===== Filing Status & Regime =====
  try {
    // FilingStatus can be at d.FilingStatus (ITR1/4) or d.PartA_GEN1.FilingStatus (ITR2/3)
    const fs = d.FilingStatus || d.PartA_GEN1?.FilingStatus || {};
    // Regime detection: ITR has multiple ways to indicate regime
    const isNewRegime = 
      fs.NewTaxRegime === 'Y' || 
      fs.OptingNewTaxRegime === 'Y' ||
      // OptOutNewTaxRegime='N' means did NOT opt out = New Regime
      (fs.OptOutNewTaxRegime === 'N') ||
      // No_OptOutNewTaxReg='N' and OptOutNewTaxRegime_Form10IEA_AY24_25='N' = New Regime
      (fs.No_OptOutNewTaxReg === 'N' && fs.OptOutNewTaxRegime_Form10IEA_AY24_25 === 'N');
    r.regime = isNewRegime ? 'New Regime' : 'Old Regime';
    r.filingType = fs.ReturnFileSec === 11 ? 'Original u/s 139(1)' : fs.ReturnFileSec === 17 ? 'Revised u/s 139(5)' : fs.ReturnFileSec === 12 ? 'Belated u/s 139(4)' : `Section ${fs.ReturnFileSec || '-'}`;
  } catch(e) {}

  // ===== Parse by ITR type =====
  if (itrKey === 'ITR1') parseITR1(d, r);
  else if (itrKey === 'ITR4') parseITR4(d, r);
  else if (itrKey === 'ITR2') parseITR2(d, r);
  else if (itrKey === 'ITR3') parseITR3(d, r);
  else if (itrKey === 'ITR5') parseITR5(d, r);
  else if (itrKey === 'ITR6') parseITR6(d, r);
  else if (itrKey === 'ITR7') parseITR6(d, r); // ITR7 has similar structure to ITR6

  return r;
}

// ===== ITR-1 (Sahaj) =====
function parseITR1(d, r) {
  const inc = d.ITR1_IncomeDeductions || d.IncomeDeductions || {};
  r.income.salary = inc.GrossSalary || inc.IncomeFromSal || 0;
  r.income.houseProperty = inc.TotalIncomeOfHP || inc.IncomeFromHP || 0;
  r.income.otherSources = inc.IncomeOthSrc || 0;
  r.grossTotal = inc.GrossTotIncome || 0;
  r.totalIncome = inc.TotalIncome || 0;

  parseChapVIA(inc.DeductUndChapVIA || d.DeductUndChapVIA || {}, r);

  const tc = d.ITR1_TaxComputation || d.TaxComputation || {};
  parseTaxComp(tc, r);
  parseTaxPaid(d, r);
}

// ===== ITR-4 (Sugam) =====
function parseITR4(d, r) {
  const inc = d.IncomeDeductions || {};
  r.income.salary = inc.IncomeFromSal || inc.GrossSalary || 0;
  r.income.houseProperty = inc.TotalIncomeOfHP || 0;
  r.income.businessProfession = inc.IncomeFromBusinessProf || inc.PersumptiveInc44ADA || inc.PersumptiveInc44AD || 0;
  r.income.otherSources = inc.IncomeOthSrc || 0;
  r.grossTotal = inc.GrossTotIncome || inc.GrossTotIncomeIncLTCG112A || 0;
  r.totalIncome = inc.TotalIncome || 0;

  // Other sources breakdown
  const othInc = inc.OthersInc?.OthersIncDtlsOthSrc || [];
  if (Array.isArray(othInc)) {
    r.income.otherSourcesBreakdown = othInc.map(o => ({
      type: o.OthSrcNatureDesc || '',
      description: o.OthSrcOthNatOfInc || '',
      amount: o.OthSrcOthAmount || 0
    }));
  }

  // Presumptive income details
  const sbp = d.ScheduleBP || {};
  r.schedules.presumptive = {
    sec44AD: sbp.PersumptiveInc44AD || sbp.IncFromSpecBusiness44AD || 0,
    sec44ADA: sbp.PersumptiveInc44ADA || sbp.IncFromSpecProf44ADA || 0,
    sec44AE: sbp.PersumptiveInc44AE || 0,
    turnoverGross: sbp.GrsTrnOverAnyOthMode || 0,
    turnoverDigital: sbp.GrsTrnOverBank || 0
  };

  parseChapVIA(inc.DeductUndChapVIA || inc.UsrDeductUndChapVIA || d.DeductUndChapVIA || {}, r);

  // ITR4 TaxComputation has different field names
  const tc = d.TaxComputation || {};
  r.tax.onIncome = tc.TotalTaxPayable || tc.TaxPayableOnTotInc || 0;
  r.tax.rebate87A = tc.Rebate87A || 0;
  r.tax.surcharge = tc.SurchargeOnAboveCrore || tc.TotalSurcharge || 0;
  r.tax.cess = tc.EducationCess || tc.HECess || 0;
  r.tax.totalLiability = tc.GrossTaxLiability || 0;
  r.tax.netLiability = tc.NetTaxLiability || 0;

  // ITR4 interest/fees
  const intPay = tc.IntrstPay || {};
  r.tax.interest234A = intPay.IntrstPayUs234A || 0;
  r.tax.interest234B = intPay.IntrstPayUs234B || 0;
  r.tax.interest234C = intPay.IntrstPayUs234C || 0;
  r.tax.lateFee = intPay.LateFilingFee234F || 0;
  r.tax.totalWithInterest = tc.TotTaxPlusIntrstPay || r.tax.netLiability;

  // ITR4 TaxPaid flat structure
  const tp = d.TaxPaid || {};
  const taxes = tp.TaxesPaid || {};
  r.tax.tds = taxes.TDS || 0;
  r.tax.tcs = taxes.TCS || 0;
  r.tax.advanceTax = taxes.AdvanceTax || 0;
  r.tax.selfAssessment = taxes.SelfAssessmentTax || 0;
  r.tax.totalPaid = taxes.TotalTaxesPaid || (r.tax.tds + r.tax.tcs + r.tax.advanceTax + r.tax.selfAssessment);

  // Refund
  r.tax.refund = d.Refund?.RefundDue || 0;
  r.tax.payable = tp.BalTaxPayable || 0;
}

// ===== ITR-2 =====
function parseITR2(d, r) {
  // Income from schedules
  const schS = d.ScheduleS || {};
  r.income.salary = schS.TotIncUnderHeadSalaries || schS.NetSalary || 0;
  const schHP = d.ScheduleHP || {};
  r.income.houseProperty = schHP.TotalIncomeOfHP || 0;
  const schOS = d.ScheduleOS || {};
  r.income.otherSources = schOS.TotIncFromOS || schOS.IncChargeable || 0;

  parseCapGains(d, r);
  const schEI = d.ScheduleEI || {};
  r.income.exemptIncome = schEI.TotalExemptInc || 0;
  r.income.agriculturalIncome = schEI.AgriInc || 0;

  // PartB-TI (can be hyphen or underscore)
  const pBTI = d['PartB-TI'] || d.PartB_TI || {};
  r.grossTotal = pBTI.GrossTotIncome || 0;
  r.totalIncome = pBTI.TotalIncome || pBTI.TotTI || 0;
  if (!r.income.salary && pBTI.Salaries) r.income.salary = pBTI.Salaries;
  if (!r.income.houseProperty && pBTI.IncomeFromHP) r.income.houseProperty = pBTI.IncomeFromHP;

  parseChapVIA(d.ScheduleVIA?.DeductUndChapVIA || d.ScheduleVIA || {}, r);

  const pBTTI = d.PartB_TTI || {};
  parseTaxFromTTI(pBTTI, r);
  parseTaxPaid(d, r);

  // Compute grossTotal if missing
  if (!r.grossTotal && r.totalIncome) {
    r.grossTotal = r.totalIncome + r.deductions.total;
  }
}

// ===== ITR-3 =====
function parseITR3(d, r) {
  // Income from schedules
  const schS = d.ScheduleS || {};
  r.income.salary = schS.TotIncUnderHeadSalaries || schS.NetSalary || 0;
  const schHP = d.ScheduleHP || {};
  r.income.houseProperty = schHP.TotalIncomeOfHP || 0;
  const schBP = d.ITR3ScheduleBP || d.ScheduleBP || {};
  r.income.businessProfession = schBP.TotBussProfIncome || schBP.NetProfitFromBusiness || schBP.ProfBfrTaxPL || 0;
  const schOS = d.ScheduleOS || {};
  r.income.otherSources = schOS.TotIncFromOS || schOS.IncChargeable ||
    schOS.IncOthThanOwnRaceHorse?.GrossIncChrgblTaxAtAppRate || 0;

  parseCapGains(d, r);
  const schEI = d.ScheduleEI || {};
  r.income.exemptIncome = schEI.TotalExemptInc || 0;
  r.income.agriculturalIncome = schEI.AgriInc || 0;

  // PartB-TI (HYPHEN key in ITR-3!)
  const pBTI = d['PartB-TI'] || d.PartB_TI || {};
  r.grossTotal = pBTI.GrossTotIncome || 0;
  r.totalIncome = pBTI.TotalIncome || pBTI.TotTI || 0;
  if (!r.income.salary && pBTI.Salaries) r.income.salary = pBTI.Salaries;
  if (!r.income.houseProperty && pBTI.IncomeFromHP) r.income.houseProperty = pBTI.IncomeFromHP;
  if (!r.income.businessProfession && pBTI.ProfBusGain?.TotProfBusGain)
    r.income.businessProfession = pBTI.ProfBusGain.TotProfBusGain;
  if (pBTI.CapGain?.ShortTermLongTermTotal)
    r.income.capitalGains.total = pBTI.CapGain.ShortTermLongTermTotal;

  parseChapVIA(d.ScheduleVIA?.DeductUndChapVIA || d.ScheduleVIA || {}, r);

  const pBTTI = d.PartB_TTI || {};
  parseTaxFromTTI(pBTTI, r);
  parseTaxPaid(d, r);

  // Compute grossTotal if missing
  if (!r.grossTotal && r.totalIncome) {
    r.grossTotal = r.totalIncome + r.deductions.total;
  }
  if (!r.grossTotal) {
    r.grossTotal = r.income.salary + r.income.houseProperty + r.income.businessProfession + r.income.capitalGains.total + r.income.otherSources;
  }
}

// ===== ITR-5 (Partnership/LLP/AOP/BOI) =====
function parseITR5(d, r) {
  const schHP = d.ScheduleHP || {};
  r.income.houseProperty = schHP.TotalIncomeOfHP || 0;
  const schBP = d.ScheduleBP || {};
  r.income.businessProfession = schBP.TotBussProfIncome || schBP.NetProfitFromBusiness || 0;
  const schOS = d.ScheduleOS || {};
  r.income.otherSources = schOS.TotIncFromOS || 0;

  parseCapGains(d, r);

  const pBTI = d['PartB-TI'] || d.PartB_TI || {};
  r.grossTotal = pBTI.GrossTotIncome || 0;
  r.totalIncome = pBTI.TotalIncome || 0;
  if (!r.income.businessProfession && pBTI.ProfBusGain?.TotProfBusGain)
    r.income.businessProfession = pBTI.ProfBusGain.TotProfBusGain;

  parseChapVIA(d.ScheduleVIA?.DeductUndChapVIA || d.ScheduleVIA || {}, r);

  const pBTTI = d.PartB_TTI || {};
  parseTaxFromTTI(pBTTI, r);
  parseTaxPaid(d, r);

  if (!r.grossTotal && r.totalIncome) r.grossTotal = r.totalIncome + r.deductions.total;
}

// ===== ITR-6 (Company) =====
function parseITR6(d, r) {
  // Company income — mostly from business
  const schHP = d.ScheduleHP || {};
  r.income.houseProperty = schHP.TotalIncomeOfHP || 0;
  const schBP = d.CorpScheduleBP || d.ScheduleBP || {};
  r.income.businessProfession = schBP.TotBussProfIncome || schBP.NetProfitFromBusiness || schBP.ProfBfrTaxPL || 0;
  const schOS = d.ScheduleOS || {};
  r.income.otherSources = schOS.TotIncFromOS || schOS.IncChargeable || 0;

  parseCapGains(d, r);

  // PartB-TI (with hyphen for ITR-6)
  const pBTI = d['PartB-TI'] || d.PartB_TI || {};
  r.grossTotal = pBTI.GrossTotIncome || 0;
  r.totalIncome = pBTI.TotalIncome || pBTI.TotTI || 0;
  if (!r.income.businessProfession && pBTI.ProfBusGain?.TotProfBusGain)
    r.income.businessProfession = pBTI.ProfBusGain.TotProfBusGain;
  if (!r.income.houseProperty && pBTI.IncomeFromHP) r.income.houseProperty = pBTI.IncomeFromHP;
  if (pBTI.IncFromOS) r.income.otherSources = r.income.otherSources || pBTI.IncFromOS;

  // Deductions under VI-A (usually minimal for companies)
  parseChapVIA(d.ScheduleVIA?.DeductUndChapVIA || d.ScheduleVIA || {}, r);

  // Tax computation from PartB_TTI (different structure for companies)
  const pBTTI = d.PartB_TTI || {};
  const comp = pBTTI.ComputationOfTaxLiability || {};
  const taxOnTI = comp.TaxPayableOnTI || {};
  r.tax.onIncome = taxOnTI.TaxAtNormalRates || taxOnTI.TaxPayableOnTotInc || 0;
  r.tax.surcharge = taxOnTI.TotalSurcharge || taxOnTI.SurchargeOnTaxPayable || 0;
  r.tax.cess = taxOnTI.EducationCess || 0;
  r.tax.totalLiability = comp.GrossTaxPayable || taxOnTI.GrossTaxLiability || 0;
  r.tax.netLiability = comp.NetTaxLiability || 0;

  // Interest/penalties
  const intPay = comp.IntrstPay || {};
  r.tax.interest234A = intPay.IntrstPayUs234A || 0;
  r.tax.interest234B = intPay.IntrstPayUs234B || 0;
  r.tax.interest234C = intPay.IntrstPayUs234C || 0;
  r.tax.lateFee = intPay.LateFilingFee234F || 0;
  r.tax.totalWithInterest = comp.TotTaxPlusIntrstPay || r.tax.netLiability;

  // Tax paid
  const taxPaid = pBTTI.TaxPaid?.TaxesPaid || d.TaxPaid?.TaxesPaid || {};
  r.tax.tds = taxPaid.TDS || 0;
  r.tax.tcs = taxPaid.TCS || 0;
  r.tax.advanceTax = taxPaid.AdvanceTax || 0;
  r.tax.selfAssessment = taxPaid.SelfAssessmentTax || 0;
  r.tax.totalPaid = taxPaid.TotalTaxesPaid || (r.tax.tds + r.tax.tcs + r.tax.advanceTax + r.tax.selfAssessment);

  // Refund / Payable
  r.tax.refund = pBTTI.Refund?.NetRefundAdjust || pBTTI.Refund?.RefundDue || 0;
  r.tax.payable = pBTTI.TaxPaid?.BalTaxPayable || 0;

  // MAT (Minimum Alternate Tax) for companies
  const mat = d.ScheduleMAT || {};
  if (mat.TaxUnderMAT || comp.TaxPayableOnDeemedTI?.TaxDeemedTISec115JB) {
    r.schedules.mat = {
      matIncome: pBTI.DeemedTotIncSec115JB || 0,
      matTax: comp.TaxPayableOnDeemedTI?.TaxDeemedTISec115JB || mat.TaxUnderMAT || 0,
      matCess: comp.TaxPayableOnDeemedTI?.EducationCess || 0,
      matTotal: comp.TaxPayableOnDeemedTI?.TotalTax || 0
    };
  }

  if (!r.grossTotal && r.totalIncome) r.grossTotal = r.totalIncome + r.deductions.total;
  if (!r.grossTotal) r.grossTotal = r.income.businessProfession + r.income.houseProperty + r.income.capitalGains.total + r.income.otherSources;
}

// ===== Shared parsers =====
function parseCapGains(d, r) {
  const schCG = d.ScheduleCGFor23 || d.ScheduleCG || {};
  const pBTI = d['PartB-TI'] || d.PartB_TI || {};
  const cg = pBTI.CapGain || {};

  r.income.capitalGains.stcg = cg.ShortTerm?.TotalShortTerm || schCG.TotalSTCG || 0;
  r.income.capitalGains.ltcg = cg.LongTerm?.TotalLongTerm || schCG.TotalLTCG || 0;
  r.income.capitalGains.total = cg.ShortTermLongTermTotal || (r.income.capitalGains.stcg + r.income.capitalGains.ltcg);
}

function parseChapVIA(ded, r) {
  if (!ded) return;
  r.deductions.sec80C = ded.Section80C || 0;
  r.deductions.sec80D = ded.Section80D || 0;
  r.deductions.sec80G = ded.Section80G || 0;
  r.deductions.sec80TTA = ded.Section80TTA || ded.Section80TTB || 0;
  r.deductions.sec80CCD = (ded.Section80CCD1B || 0) + (ded.Section80CCDEmployeeOrSE || 0) + (ded.Section80CCDEmployer || 0);
  r.deductions.total = ded.TotalChapVIADeductions || (r.deductions.sec80C + r.deductions.sec80D + r.deductions.sec80G + r.deductions.sec80TTA + r.deductions.sec80CCD);

  // Store all non-zero deductions in details
  r.deductions.details = {};
  for (const [k, v] of Object.entries(ded)) {
    if (typeof v === 'number' && v > 0 && k.startsWith('Section')) r.deductions.details[k] = v;
  }
}

function parseTaxComp(tc, r) {
  if (!tc) return;
  r.tax.onIncome = tc.TotalTaxPayable || tc.TaxPayableOnTotInc || tc.TaxPayable || 0;
  r.tax.rebate87A = tc.Rebate87A || 0;
  r.tax.surcharge = tc.SurchargeOnAboveCrore || tc.TotalSurcharge || 0;
  r.tax.cess = tc.EducationCess || tc.HECess || 0;
  r.tax.totalLiability = tc.GrossTaxLiability || tc.NetTaxLiability || 0;
}

function parseTaxFromTTI(pBTTI, r) {
  const comp = pBTTI.ComputationOfTaxLiability || pBTTI || {};
  const taxOnTI = comp.TaxPayableOnTI || {};

  if (typeof taxOnTI === 'object') {
    r.tax.onIncome = taxOnTI.TaxPayableOnTotInc || taxOnTI.TaxAtNormalRatesOnAggrInc || 0;
    r.tax.rebate87A = taxOnTI.Rebate87A || 0;
    r.tax.surcharge = (taxOnTI.TotalSurcharge || 0) + (taxOnTI.SurchargeOnAboveCrore || 0);
    r.tax.cess = taxOnTI.EducationCess || taxOnTI.HECess || 0;
    r.tax.totalLiability = taxOnTI.GrossTaxLiability || (r.tax.onIncome - r.tax.rebate87A + r.tax.surcharge + r.tax.cess);
  } else {
    r.tax.onIncome = taxOnTI || 0;
  }

  r.tax.totalLiability = comp.NetTaxLiability || comp.GrossTaxLiability || r.tax.totalLiability || 0;

  // Interest and fees
  const intPay = comp.IntrstPay || {};
  r.tax.interest234A = intPay.IntrstPayUs234A || 0;
  r.tax.interest234B = intPay.IntrstPayUs234B || 0;
  r.tax.interest234C = intPay.IntrstPayUs234C || 0;
  r.tax.lateFee = intPay.LateFilingFee234F || 0;
}

function parseTaxPaid(d, r) {
  // TaxPaid section
  const tp = d.TaxPaid || {};
  const tds1 = tp.TaxesPaid || tp.TDSonSalaries || {};

  // Aggregate TDS from all schedules
  let totalTDS = 0;
  // TDS on Salary (Schedule TDS1)
  const tds16A = d.ScheduleTDS1 || d.TDSonSalaries || {};
  if (tds16A.TotalTDSonSal) totalTDS += tds16A.TotalTDSonSal;
  else if (Array.isArray(tds16A.TDSonSalaryDtls)) {
    tds16A.TDSonSalaryDtls.forEach(t => totalTDS += (t.TotalTDSSal || 0));
  }

  // TDS on other than salary (Schedule TDS2)
  const tds2 = d.TDSonOthThanSals || d.ScheduleTDS2 || {};
  if (tds2.TotalTDSonOthThanSal) totalTDS += tds2.TotalTDSonOthThanSal;
  else if (Array.isArray(tds2.TDSonOthThanSalDtls)) {
    tds2.TDSonOthThanSalDtls.forEach(t => totalTDS += (t.TotTDSOnAmtPaid || t.TotalTDSOth || 0));
  }

  // TDS3 details
  const tds3 = d.ScheduleTDS3Dtls || d.TDSonOthThanSal3 || {};
  if (tds3.TotalTDS3OnOthThanSal) totalTDS += tds3.TotalTDS3OnOthThanSal;
  else if (Array.isArray(tds3.TDS3OnOthThanSalDtls || tds3.TDS3Dtls)) {
    (tds3.TDS3OnOthThanSalDtls || tds3.TDS3Dtls || []).forEach(t => totalTDS += (t.TotTDSOnAmtPaid || 0));
  }

  r.tax.tds = totalTDS || tds1.TotalTDSClaimed || tp.TotalTDSClaimed || 0;

  // Advance Tax
  const at = tp.AdvanceTax || d.ScheduleIT || {};
  if (at.TotalAdvanceTax) r.tax.advanceTax = at.TotalAdvanceTax;
  else if (Array.isArray(at.AdvTaxDtls)) {
    r.tax.advanceTax = at.AdvTaxDtls.reduce((s, t) => s + (t.AdvTaxAmtPaid || 0), 0);
  }

  // Self Assessment Tax
  const sat = tp.SelfAssessmentTax || {};
  if (sat.TotalSelfAssessmentTax) r.tax.selfAssessment = sat.TotalSelfAssessmentTax;

  // TCS
  const tcs = d.ScheduleTCS || {};
  r.tax.tcs = tcs.TotalSchTCS || 0;

  r.tax.totalPaid = r.tax.tds + r.tax.advanceTax + r.tax.selfAssessment + (r.tax.tcs || 0);

  // Refund and Payable
  const refund = d.Refund || d.TaxComputation || d.PartB_TTI?.ComputationOfTaxLiability || {};
  r.tax.refund = refund.RefundDue || 0;
  r.tax.payable = refund.BalTaxPayable || 0;

  // If total paid > liability, compute refund
  if (r.tax.totalPaid > r.tax.totalLiability && !r.tax.refund) {
    r.tax.refund = r.tax.totalPaid - r.tax.totalLiability;
  }
}

module.exports = { analyzeITR };
